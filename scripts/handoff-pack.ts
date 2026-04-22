#!/usr/bin/env bun
/**
 * ashlr handoff-pack — generates a compact context primer so the next
 * session can resume cold without re-exploring.
 *
 * Writes to .ashlr/handoffs/YYYY-MM-DD-HHMMSS-<rand>.md
 *
 * CLI flags:
 *   --session <id>   override which session to pack (default: current)
 *   --last           re-print the most recent handoff (no new write)
 *   --dir <path>     override output directory
 *   --days N         how many days of log to scan (default: 7)
 *
 * Exported surface:
 *   buildHandoffPack(opts?)  -> { path: string; content: string }, never throws.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, basename, relative } from "path";
import { randomBytes } from "crypto";
import { currentSessionId, readCurrentSession, readStats } from "../servers/_stats.ts";

// ---------------------------------------------------------------------------
// Schema (matches session-log-report.ts)
// ---------------------------------------------------------------------------

interface LogRecord {
  ts: string;
  agent: string;
  event: string;
  tool: string;
  cwd: string;
  session: string;
  input_size: number;
  output_size: number;
  calls?: number;
  tokens_saved?: number;
  started_at?: string;
  reason?: string;
  // TodoWrite input payload (serialized JSON string or object)
  input?: unknown;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BuildHandoffPackOpts {
  /** Override home dir — used by tests. */
  home?: string;
  /** Override session id to pack. Default: currentSessionId(). */
  sessionId?: string;
  /** Override output directory. Default: <home>/.ashlr/handoffs/ */
  outDir?: string;
  /** Injected now in ms — tests pin this. */
  now?: number;
  /** Max lines per file. */
  limitLines?: number;
  /** Random suffix override — lets tests force collision-safe filenames. */
  randSuffix?: string;
  /** Skip writing to disk and return content only (for tests). */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// JSONL helpers
// ---------------------------------------------------------------------------

function readLines(path: string, limit?: number): string[] {
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    return limit ? lines.slice(0, limit) : lines;
  } catch {
    return [];
  }
}

function parseRecords(lines: string[]): LogRecord[] {
  const out: LogRecord[] = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as Partial<LogRecord>;
      if (typeof r.ts !== "string" || typeof r.event !== "string") continue;
      out.push({
        ts: r.ts,
        agent: r.agent ?? "unknown",
        event: r.event,
        tool: r.tool ?? "unknown",
        cwd: r.cwd ?? "",
        session: r.session ?? "",
        input_size: typeof r.input_size === "number" ? r.input_size : 0,
        output_size: typeof r.output_size === "number" ? r.output_size : 0,
        calls: r.calls,
        tokens_saved: r.tokens_saved,
        started_at: r.started_at,
        reason: r.reason,
        input: r.input,
      });
    } catch {
      // skip malformed
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timestamp filename helper
// ---------------------------------------------------------------------------

function makeFilename(now: number, randSuffix?: string): string {
  const d = new Date(now);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const date =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time =
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const suffix = randSuffix ?? randomBytes(3).toString("hex");
  return `${date}-${time}-${suffix}.md`;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}K`;
}

async function buildSessionSummarySection(
  sessionId: string,
  statsHome?: string,
): Promise<string> {
  try {
    // readCurrentSession reads from the real stats.json path — we can't
    // easily redirect it in tests. For test isolation, callers use dryRun +
    // a synthetic sessionId that won't be found, so we gracefully degrade.
    const session = await readCurrentSession(sessionId);
    const lines: string[] = ["## Session Summary", ""];

    lines.push(`- Session ID: ${sessionId}`);
    lines.push(`- Started at: ${session.startedAt}`);
    lines.push(`- Calls: ${session.calls}`);
    lines.push(`- Tokens saved: ${fmtTokens(session.tokensSaved)}`);

    // Dominant tools — top 3 by calls
    const toolEntries = Object.entries(session.byTool)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 3);

    if (toolEntries.length > 0) {
      lines.push(`- Dominant tools:`);
      for (const [tool, stat] of toolEntries) {
        lines.push(`  - ${tool}: ${stat.calls} calls, ${fmtTokens(stat.tokensSaved)} tok saved`);
      }
    } else {
      lines.push(`- Dominant tools: (none recorded)`);
    }

    return lines.join("\n");
  } catch {
    return [
      "## Session Summary",
      "",
      `- Session ID: ${sessionId}`,
      "- Stats unavailable (no stats.json or session not found).",
    ].join("\n");
  }
}

const READ_TOOLS = new Set([
  "Read", "Edit", "MultiEdit", "ashlr__read", "ashlr__edit", "ashlr__multi_edit",
]);

function buildRecentFilesSection(
  records: LogRecord[],
  sessionId: string,
  cwd: string,
): string {
  const sessionRecords = sessionId
    ? records.filter((r) => r.session === sessionId)
    : records;

  const pathCounts = new Map<string, number>();

  for (const r of sessionRecords) {
    if (!READ_TOOLS.has(r.tool)) continue;
    // We don't have the file path in the log. Use cwd as a coarse proxy, but
    // more usefully track input_size as a stand-in identifier. Since the path
    // isn't logged, we emit the cwd + tool combination as context.
    // Best we can do: emit unique (cwd, tool) pairs.
    const key = r.cwd || cwd;
    pathCounts.set(key, (pathCounts.get(key) ?? 0) + 1);
  }

  const lines: string[] = ["## Recent Files Touched", ""];

  if (pathCounts.size === 0) {
    lines.push("(no file operations recorded for this session)");
    return lines.join("\n");
  }

  const sorted = [...pathCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  for (const [p, count] of sorted) {
    // Show last two path components to keep lines short but identifiable.
    // Split on both separators so Windows cwds (C:\foo\bar) render correctly.
    const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
    const display = parts.length >= 2
      ? parts.slice(-2).join("/")
      : parts[0] ?? p;
    lines.push(`- ${display} (${count} ops)`);
  }

  return lines.join("\n");
}

function buildGenomeSection(cwd: string): string {
  const lines: string[] = ["## Genome Status", ""];

  if (!cwd) {
    lines.push("(no working directory)");
    return lines.join("\n");
  }

  const manifestPath = join(cwd, ".ashlrcode", "genome", "manifest.json");
  if (!existsSync(manifestPath)) {
    lines.push("No genome found. Run /ashlr-genome-init to initialize.");
    return lines.join("\n");
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      sections?: unknown[];
      updatedAt?: string;
      [k: string]: unknown;
    };
    const sectionCount = Array.isArray(manifest.sections) ? manifest.sections.length : "?";
    const updatedAt = manifest.updatedAt ?? "unknown";
    lines.push(`- Sections: ${sectionCount}`);
    lines.push(`- Last updated: ${updatedAt}`);
  } catch {
    lines.push("Manifest exists but could not be parsed.");
  }

  return lines.join("\n");
}

function buildOpenTodosSection(records: LogRecord[], sessionId: string): string {
  const lines: string[] = ["## Open Todos", ""];

  const todoRecords = records.filter(
    (r) =>
      r.tool === "TodoWrite" &&
      (sessionId ? r.session === sessionId : true),
  );

  if (todoRecords.length === 0) {
    lines.push("(no TodoWrite calls in this session)");
    return lines.join("\n");
  }

  // Use the latest TodoWrite record's input
  const latest = todoRecords[todoRecords.length - 1]!;
  const input = latest.input;

  if (!input) {
    lines.push("(TodoWrite called but input not recorded)");
    return lines.join("\n");
  }

  try {
    // input may be a JSON string or already an object
    const parsed: unknown =
      typeof input === "string" ? JSON.parse(input) : input;

    // TodoWrite input shape: { todos: Array<{ content, status, priority, id }> }
    const todos =
      parsed !== null &&
      typeof parsed === "object" &&
      "todos" in (parsed as object) &&
      Array.isArray((parsed as { todos: unknown }).todos)
        ? (parsed as { todos: Array<{ content?: string; status?: string; priority?: string }> }).todos
        : Array.isArray(parsed)
        ? (parsed as Array<{ content?: string; status?: string; priority?: string }>)
        : null;

    if (!todos) {
      lines.push("(could not parse todo list)");
      return lines.join("\n");
    }

    for (const todo of todos) {
      const status = todo.status ?? "pending";
      const content = todo.content ?? "(no content)";
      const priority = todo.priority ? ` [${todo.priority}]` : "";
      lines.push(`- [${status}]${priority} ${content}`);
    }
  } catch {
    lines.push("(could not parse TodoWrite input)");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HandoffResult {
  path: string;
  content: string;
  /** True when --last was used and no prior handoffs exist. */
  empty?: boolean;
}

export async function buildHandoffPack(
  opts: BuildHandoffPackOpts = {},
): Promise<HandoffResult> {
  const homeDir = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const outDir = opts.outDir ?? join(homeDir, ".ashlr", "handoffs");
  const sessionId = opts.sessionId ?? currentSessionId();

  const logPath = join(homeDir, ".ashlr", "session-log.jsonl");
  const rotatedPath = join(homeDir, ".ashlr", "session-log.jsonl.1");

  const lines1 = readLines(rotatedPath, opts.limitLines);
  const lines2 = readLines(logPath, opts.limitLines);
  const allRecords = parseRecords([...lines1, ...lines2]);

  // Best-guess cwd: most common cwd in session records
  const sessionRecords = allRecords.filter((r) => r.session === sessionId);
  const cwdCounts = new Map<string, number>();
  for (const r of sessionRecords) {
    if (r.cwd) cwdCounts.set(r.cwd, (cwdCounts.get(r.cwd) ?? 0) + 1);
  }
  let cwd = "";
  let cwdMax = 0;
  for (const [c, n] of cwdCounts) {
    if (n > cwdMax) { cwdMax = n; cwd = c; }
  }
  // Fall back to process.cwd() if no session records found
  if (!cwd) cwd = process.cwd();

  const sections: string[] = [];

  sections.push(await buildSessionSummarySection(sessionId));
  sections.push(buildRecentFilesSection(allRecords, sessionId, cwd));
  sections.push(buildGenomeSection(cwd));
  sections.push(buildOpenTodosSection(allRecords, sessionId));

  const filename = makeFilename(now, opts.randSuffix);
  const outPath = join(outDir, filename);

  const footerNote =
    `---\n` +
    `Paste the contents of ${outPath} into your next session to resume context.`;

  const content = [
    `# ashlr handoff — ${new Date(now).toISOString()}`,
    "",
    ...sections.map((s) => s + "\n"),
    footerNote,
  ].join("\n");

  if (!opts.dryRun) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, content, "utf-8");
  }

  return { path: outPath, content };
}

/** Return the most recent existing handoff file, or null. */
export function findLastHandoff(outDir: string): string | null {
  try {
    if (!existsSync(outDir)) return null;
    const files = readdirSync(outDir)
      .filter((f) => f.endsWith(".md"))
      .sort() // lexicographic == chronological for YYYY-MM-DD-HHMMSS prefix
      .reverse();
    return files.length > 0 ? join(outDir, files[0]!) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);

  const getFlag = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);

  const sessionFlag = getFlag("--session");
  const dirFlag = getFlag("--dir");
  const lastFlag = hasFlag("--last");

  const homeDir = homedir();
  const outDir = dirFlag ?? join(homeDir, ".ashlr", "handoffs");

  if (lastFlag) {
    const last = findLastHandoff(outDir);
    if (!last) {
      process.stdout.write("(no handoffs yet)\n");
    } else {
      const preview = readFileSync(last, "utf-8").split("\n").slice(0, 5).join("\n");
      process.stdout.write(`Last handoff: ${last}\n\n${preview}\n...\n`);
    }
    process.exit(0);
  }

  buildHandoffPack({
    sessionId: sessionFlag,
    outDir,
  })
    .then(({ path, content }) => {
      const preview = content.split("\n").slice(0, 5).join("\n");
      process.stdout.write(`Handoff written: ${path}\n\n${preview}\n...\n`);
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`handoff-pack failed: ${msg}\n`);
    })
    .finally(() => process.exit(0));
}
