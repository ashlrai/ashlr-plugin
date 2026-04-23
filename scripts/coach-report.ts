#!/usr/bin/env bun
/**
 * ashlr coach report — reads ~/.ashlr/session-log.jsonl (+ rotated .1)
 * and emits proactive nudges about tokens that could have been saved.
 *
 * Exported surface:
 *   buildCoachReport(opts?)  -> formatted string, never throws.
 *
 * CLI: `bun run scripts/coach-report.ts [--days N]`
 *   Exits 0 always.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join, relative } from "path";

// ---------------------------------------------------------------------------
// Schema (matches session-log-report.ts LogRecord shape)
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
  // session_end / TodoWrite extras
  calls?: number;
  tokens_saved?: number;
  started_at?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BuildCoachReportOpts {
  /** Override home dir — used by tests. */
  home?: string;
  /** How many days back to scan (default: 7). */
  days?: number;
  /** Injected now in ms — tests pin this. */
  now?: number;
  /** Max lines per file (default: unlimited). */
  limitLines?: number;
}

// ---------------------------------------------------------------------------
// JSONL reader (same pattern as session-log-report.ts)
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
      });
    } catch {
      // skip malformed lines silently
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const WIDTH = 78;

function rule(): string {
  return "-".repeat(WIDTH);
}

// Bullets are emitted as single lines; terminal/renderer handles soft wrap.
// This keeps toContain checks in tests unambiguous across word boundaries.
function wrap(text: string): string {
  return text;
}

function fmtKtok(tokens: number): string {
  if (tokens < 1000) return `${tokens}tok`;
  return `${(tokens / 1000).toFixed(1)}Ktok`;
}

// ---------------------------------------------------------------------------
// Rule checks
// ---------------------------------------------------------------------------

interface Bullet {
  text: string;
}

/**
 * Rule 1: Native Read on large files.
 * tool === "Read" AND input_size > 2048.
 * Potential savings = sum(input_size) * 0.6 / 4 (bytes -> tokens @ 4 bytes/tok,
 * 60% reduction from ashlr__read's snipCompact).
 */
function checkNativeReadLarge(records: LogRecord[]): Bullet | null {
  const hits = records.filter(
    (r) => r.event === "tool_call" && r.tool === "Read" && r.input_size > 2048,
  );
  if (hits.length === 0) return null;
  const totalBytes = hits.reduce((s, r) => s + r.input_size, 0);
  const wastedTokens = Math.round((totalBytes * 0.6) / 4);
  const n = hits.length;
  return {
    text: wrap(
      `Used native Read on ${n} large file${n === 1 ? "" : "s"} — ` +
        `~${fmtKtok(wastedTokens)} wasted. ` +
        `Try /ashlr-allow or set ASHLR_ENFORCE=1.`,
    ),
  };
}

/**
 * Rule 2: Native Grep usage.
 * tool === "Grep".
 */
function checkNativeGrep(records: LogRecord[]): Bullet | null {
  const hits = records.filter(
    (r) => r.event === "tool_call" && r.tool === "Grep",
  );
  if (hits.length === 0) return null;
  const n = hits.length;
  return {
    text: wrap(
      `Native Grep fired ${n} time${n === 1 ? "" : "s"} — pays full rg output each call. ` +
        `ashlr__grep averages 5x smaller.`,
    ),
  };
}

/**
 * Rule 3: Long Bash outputs uncompressed.
 * tool === "Bash" AND output_size > 16384.
 */
function checkLargeBashOutput(records: LogRecord[]): Bullet | null {
  const hits = records.filter(
    (r) => r.event === "tool_call" && r.tool === "Bash" && r.output_size > 16_384,
  );
  if (hits.length === 0) return null;
  const m = hits.length;
  // Approximate token class: largest output / 4
  const maxOut = Math.max(...hits.map((r) => r.output_size));
  const tokClass = fmtKtok(Math.round(maxOut / 4));
  return {
    text: wrap(
      `Native Bash returned ${tokClass}-class output ${m} time${m === 1 ? "" : "s"} — ` +
        `ashlr__bash auto-compresses.`,
    ),
  };
}

/**
 * Rule 4: No genome but heavy ashlr__grep usage.
 * Find the project (cwd) with the most ashlr__grep calls.
 * If that project has no .ashlrcode/genome/manifest.json, fire the bullet.
 */
function checkNoGenome(records: LogRecord[]): Bullet | null {
  const grepRecords = records.filter(
    (r) => r.event === "tool_call" && r.tool === "ashlr__grep" && r.cwd,
  );
  if (grepRecords.length === 0) return null;

  // Tally per-project
  const byCwd = new Map<string, number>();
  for (const r of grepRecords) {
    byCwd.set(r.cwd, (byCwd.get(r.cwd) ?? 0) + 1);
  }

  // Top project by ashlr__grep calls
  let topCwd = "";
  let topCount = 0;
  for (const [cwd, count] of byCwd) {
    if (count > topCount) {
      topCount = count;
      topCwd = cwd;
    }
  }

  if (topCount < 3) return null; // not "heavy" usage

  const manifestPath = join(topCwd, ".ashlrcode", "genome", "manifest.json");
  if (existsSync(manifestPath)) return null;

  // Project display name: last path component (platform-agnostic)
  const projectName = basename(topCwd) || topCwd;

  return {
    text: wrap(
      `Project ${projectName} has ${topCount} ashlr__grep calls but no genome — ` +
        `run /ashlr-genome-init for ~4x better retrieval.`,
    ),
  };
}

/**
 * Rule 5: Repeated reads of the same file within one session.
 * Within same session field, find paths (from input parsed as file path)
 * that appear >= 3 times across Read/ashlr__read tool calls.
 * We use the record's cwd + a stable key derived from input_size grouping as
 * a proxy — but more precisely we look for same (session, tool, cwd) groups
 * where input_size repeats. However, the log doesn't store the path argument
 * directly. We detect repetition by grouping on (session, tool, cwd) with
 * identical input_size as a proxy for "same file".
 *
 * Actually the spec says "count records where a path appears >= 3 times" but
 * the path isn't in the log schema. We instead track (session, cwd, tool,
 * input_size) as a file fingerprint — same size + same cwd + same session
 * implies the same file was re-read.
 */
function checkRepeatedReads(records: LogRecord[]): Bullet | null {
  const readTools = new Set(["Read", "ashlr__read"]);
  const readRecords = records.filter(
    (r) => r.event === "tool_call" && readTools.has(r.tool) && r.input_size > 0,
  );
  if (readRecords.length === 0) return null;

  // Group by (session, cwd, input_size) as file fingerprint
  const counts = new Map<string, number>();
  for (const r of readRecords) {
    const key = `${r.session}|${r.cwd}|${r.input_size}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Find worst offender
  let maxCount = 0;
  let maxKey = "";
  for (const [key, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      maxKey = key;
    }
  }

  if (maxCount < 3) return null;

  const [, cwd, sizeStr] = maxKey.split("|");
  const sizeBytes = parseInt(sizeStr ?? "0", 10);
  // Use cwd basename as proxy for file location descriptor
  const projectName = basename(cwd ?? "") || (cwd ?? "unknown");
  const sizeDesc = sizeBytes > 1024
    ? `~${(sizeBytes / 1024).toFixed(1)}K`
    : `~${sizeBytes}B`;

  return {
    text: wrap(
      `A ${sizeDesc} file in ${projectName} was re-read ${maxCount} times in one session — ` +
        `the 2nd+ reads were cache hits (free) but ashlr__read's in-process cache ` +
        `only fires for exact mtime matches.`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildCoachReport(opts: BuildCoachReportOpts = {}): string {
  const homeDir = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 7;
  const windowMs = days * 24 * 60 * 60 * 1000;
  const windowStart = now - windowMs;

  const logPath = join(homeDir, ".ashlr", "session-log.jsonl");
  const rotatedPath = join(homeDir, ".ashlr", "session-log.jsonl.1");

  const lines1 = readLines(rotatedPath, opts.limitLines);
  const lines2 = readLines(logPath, opts.limitLines);
  const allLines = [...lines1, ...lines2];

  const allRecords = parseRecords(allLines);

  // Filter to window
  const records = allRecords.filter((r) => {
    const ts = Date.parse(r.ts);
    return Number.isFinite(ts) && ts >= windowStart;
  });

  const scanned = allRecords.length;

  const header =
    `ashlr coach · last ${days} day${days === 1 ? "" : "s"} · ` +
    `session-log records scanned: ${scanned}`;

  const bullets: Bullet[] = [];

  const r1 = checkNativeReadLarge(records);
  if (r1) bullets.push(r1);

  const r2 = checkNativeGrep(records);
  if (r2) bullets.push(r2);

  const r3 = checkLargeBashOutput(records);
  if (r3) bullets.push(r3);

  const r4 = checkNoGenome(records);
  if (r4) bullets.push(r4);

  const r5 = checkRepeatedReads(records);
  if (r5) bullets.push(r5);

  const footer =
    "Run /ashlr-usage for full tool breakdown · /ashlr-savings for totals.";

  const parts: string[] = [header, rule()];

  if (bullets.length === 0) {
    parts.push("No obvious improvements — you're using the plugin well.");
  } else {
    for (const b of bullets.slice(0, 5)) {
      parts.push(`- ${b.text}`);
    }
  }

  parts.push(rule());
  parts.push(footer);

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    // Parse --days N flag
    const args = process.argv.slice(2);
    const daysIdx = args.indexOf("--days");
    const days = daysIdx !== -1 && args[daysIdx + 1]
      ? parseInt(args[daysIdx + 1]!, 10)
      : 7;

    process.stdout.write(buildCoachReport({ days: isNaN(days) ? 7 : days }) + "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`coach-report failed: ${msg}\n`);
  }
  process.exit(0);
}
