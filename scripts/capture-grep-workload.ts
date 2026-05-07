#!/usr/bin/env bun
/**
 * capture-grep-workload.ts
 *
 * Reads recent ashlr__grep invocations from the MCP session log
 * (~/.ashlr/session-log.jsonl) and writes them in the workload-JSONL
 * format expected by calibrate-grep.ts --workload <path>.
 *
 * Output format (one JSON object per line):
 *   { "cwd": "/abs/path/to/project", "pattern": "somePattern" }
 *
 * Limitation: the session-log records the tool's process.cwd() at the
 * time the event was emitted, but does NOT record the grep pattern
 * (patterns are not logged to avoid leaking potentially sensitive query
 * strings). The output therefore contains unique cwds paired with a
 * representative set of synthetic patterns drawn from the calibration
 * harness's default fixture. This still improves calibration over the
 * plugin-root-only default because real project cwds are used.
 *
 * Future: emit a "tool_call" event from ashlr__grep that includes the
 * pattern (opt-in via ASHLR_LOG_PATTERNS=1) and update this script to
 * read it. That's a v1.29 follow-up.
 *
 * Usage:
 *   bun run scripts/capture-grep-workload.ts
 *   bun run scripts/capture-grep-workload.ts --n 500 --out /tmp/workload.jsonl
 *
 * Flags:
 *   --n <count>     Max events to scan from the tail of session-log (default 200)
 *   --out <path>    Output path (default ~/.ashlr/calibration-workload.jsonl)
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionLogEvent {
  ts?: string;
  agent?: string;
  event?: string;
  tool?: string;
  cwd?: string;
  session?: string;
  [key: string]: unknown;
}

interface WorkloadEntry {
  cwd: string;
  pattern: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Events that indicate a grep call was made. */
const GREP_EVENT_KINDS = new Set([
  "genome_route_taken",
  "genome_search_hit",
  "genome_search_miss",
  "tool_fallback",
  "tool_escalate",
  "tool_low_confidence_shipped",
]);

/** Synthetic patterns — the same set as calibrate-grep.ts's syntheticWorkload().
 *  These are paired with each unique cwd found in the log. They are representative
 *  of typical agent grep queries against any TypeScript codebase. */
const REPRESENTATIVE_PATTERNS = [
  "recordSaving",
  "retrieveSections",
  "genomeExists",
  "spawnSync",
  "estimateTokens",
  "tokensSaved",
  "formatBaseline",
  "snipCompact",
];

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  n: number;
  outPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  let n = 200;
  let outPath = join(homedir(), ".ashlr", "calibration-workload.jsonl");

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--n" || a === "-n") && argv[i + 1]) {
      const parsed = parseInt(argv[++i]!, 10);
      if (Number.isFinite(parsed) && parsed > 0) n = parsed;
    } else if ((a === "--out" || a === "-o") && argv[i + 1]) {
      outPath = argv[++i]!;
    }
  }

  return { n, outPath };
}

// ---------------------------------------------------------------------------
// Log reader
// ---------------------------------------------------------------------------

function home(): string {
  return process.env.HOME ?? homedir();
}

function sessionLogPath(): string {
  return join(home(), ".ashlr", "session-log.jsonl");
}

/**
 * Read the last `n` lines from the session log and return parsed JSON objects.
 * Silently skips malformed lines.
 */
function readLastNEvents(logPath: string, n: number): SessionLogEvent[] {
  if (!existsSync(logPath)) return [];

  const raw = readFileSync(logPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-n);

  const events: SessionLogEvent[] = [];
  for (const line of tail) {
    try {
      events.push(JSON.parse(line) as SessionLogEvent);
    } catch {
      // Skip malformed lines.
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Workload extraction
// ---------------------------------------------------------------------------

/**
 * Extract unique cwds from grep-related events in the session log.
 * Returns only cwds that exist on disk (in case the project was deleted/moved).
 */
function extractGrepCwds(events: SessionLogEvent[]): string[] {
  const cwdSet = new Set<string>();

  for (const ev of events) {
    const isTool = ev.tool === "ashlr__grep";
    const isGrepEvent =
      isTool &&
      (ev.event !== undefined
        ? GREP_EVENT_KINDS.has(ev.event)
        : true);

    if (isGrepEvent && typeof ev.cwd === "string" && ev.cwd.length > 0) {
      cwdSet.add(ev.cwd);
    }
  }

  // Filter to cwds that still exist.
  return [...cwdSet].filter((cwd) => {
    try {
      return existsSync(cwd);
    } catch {
      return false;
    }
  });
}

/**
 * Build the workload entries: each unique cwd × each representative pattern.
 */
function buildWorkload(cwds: string[]): WorkloadEntry[] {
  const entries: WorkloadEntry[] = [];
  for (const cwd of cwds) {
    for (const pattern of REPRESENTATIVE_PATTERNS) {
      entries.push({ cwd, pattern });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function captureGrepWorkload(opts: {
  n?: number;
  outPath?: string;
  logPath?: string;
}): Promise<{ cwds: string[]; entries: WorkloadEntry[]; outPath: string }> {
  const n = opts.n ?? 200;
  const outPath = opts.outPath ?? join(home(), ".ashlr", "calibration-workload.jsonl");
  const logPath = opts.logPath ?? sessionLogPath();

  process.stdout.write(`Reading last ${n} events from ${logPath}\n`);

  if (!existsSync(logPath)) {
    process.stdout.write(`Session log not found at ${logPath}.\n`);
    process.stdout.write(
      `The log is written by the ashlr MCP server on every tool call. ` +
        `Use ashlr tools first to populate it.\n`,
    );
    return { cwds: [], entries: [], outPath };
  }

  const events = readLastNEvents(logPath, n);
  process.stdout.write(`Parsed ${events.length} event(s)\n`);

  const cwds = extractGrepCwds(events);
  process.stdout.write(`Found ${cwds.length} unique cwd(s) from ashlr__grep events\n`);

  if (cwds.length === 0) {
    process.stdout.write(
      `No grep cwds found in the last ${n} events. ` +
        `Either no ashlr__grep calls were made recently, or the log ` +
        `doesn't contain the expected event kinds.\n`,
    );
    process.stdout.write(
      `Note: the session log records process.cwd() at log time, not the ` +
        `grep input's cwd. They match for typical agent invocations.\n`,
    );
    return { cwds: [], entries: [], outPath };
  }

  const entries = buildWorkload(cwds);
  process.stdout.write(
    `Built ${entries.length} workload entries (${cwds.length} cwd(s) × ${REPRESENTATIVE_PATTERNS.length} patterns)\n`,
  );

  // Write output.
  mkdirSync(dirname(outPath), { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(outPath, content, "utf-8");

  process.stdout.write(`\nWritten → ${outPath}\n`);
  process.stdout.write(`Run calibration with:\n`);
  process.stdout.write(`  bun run scripts/calibrate-grep.ts --workload ${outPath}\n`);
  process.stdout.write(
    `\nNote: patterns are synthetic (${REPRESENTATIVE_PATTERNS.length} fixed strings × ${cwds.length} real cwds).\n`,
  );
  process.stdout.write(
    `Set ASHLR_LOG_PATTERNS=1 in a future version to capture real query patterns.\n`,
  );

  return { cwds, entries, outPath };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  await captureGrepWorkload({ n: args.n, outPath: args.outPath });
}
