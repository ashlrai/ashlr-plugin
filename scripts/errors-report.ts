#!/usr/bin/env bun
/**
 * ashlr errors-report — reads ~/.ashlr/ashlr.log (+ rotated .1) and
 * ~/.ashlr/session-log.jsonl and produces a deduped error summary.
 *
 * Exported surface:
 *   buildErrorsReport(opts?)  → formatted string, never throws.
 *   normalizeMessage(msg)     → canonical signature string (exported for tests).
 *
 * CLI: `bun run scripts/errors-report.ts [--hours N]`
 *   Exits 0 always.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ErrorsReportOptions {
  /** Override $HOME for testing. */
  home?: string;
  /** Window in hours (default: 168 = last week). */
  hours?: number;
  /** Override Date.now() for deterministic tests. */
  now?: number;
}

interface RawLogLine {
  ts: Date;
  level: string;
  message: string;
  source: "log" | "session-log";
  tool?: string;
}

export interface ErrorSignature {
  signature: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  sample: string;
}

export interface ToolErrorCount {
  tool: string;
  count: number;
}

export interface ErrorsReportData {
  totalErrors: number;
  uniqueSignatures: number;
  windowHours: number;
  timeRangeStart: Date | null;
  timeRangeEnd: Date | null;
  topSignatures: ErrorSignature[];
  toolBreakdown: ToolErrorCount[];
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single line from ashlr.log.
 * Formats seen in the wild:
 *   "2026-03-06 17:49:22,059 \e[33mWARNING\e[0m ashlr message"
 *   "[2026-03-06T17:49:22Z] ERROR message"
 *   "ERROR: bare message without timestamp"
 *   "2026-03-06 17:49:22,059 INFO aiohttp.access ..."
 *
 * Returns null for lines that don't look like errors/warnings.
 */
function parseLogLine(raw: string): RawLogLine | null {
  // Strip ANSI escape sequences.
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!clean) return null;

  // Detect level keywords — we only care about WARNING and ERROR lines.
  const levelMatch = clean.match(/\b(ERROR|WARNING|WARN|CRITICAL|FATAL)\b/i);
  if (!levelMatch) return null;
  const level = levelMatch[1].toUpperCase();

  // Try to extract a timestamp.
  let ts: Date | null = null;

  // "YYYY-MM-DD HH:MM:SS,mmm" or "YYYY-MM-DD HH:MM:SS.mmm"
  const sqlTs = clean.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[,.]?\d*)/);
  if (sqlTs) {
    ts = new Date(sqlTs[1].replace(",", ".").replace(" ", "T"));
  }

  // "[ISO-timestamp]" prefix
  if (!ts) {
    const isoTs = clean.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.Z+-]+)\]/);
    if (isoTs) ts = new Date(isoTs[1]);
  }

  if (!ts || isNaN(ts.getTime())) {
    // No parseable timestamp — treat as "now" so it passes window filtering
    // only if caller uses a lenient window. We use epoch 0 to mark unknown.
    ts = new Date(0);
  }

  // Extract the message portion: everything after the level keyword.
  const afterLevel = clean.slice(clean.indexOf(levelMatch[0]) + levelMatch[0].length).trim();
  // Drop leading logger-name tokens (e.g., "ashlr ", "aiohttp.access ")
  const message = afterLevel.replace(/^[\w.]+ /, "").trim() || clean;

  return { ts, level, message, source: "log" };
}

/**
 * Parse session-log.jsonl lines looking for tool_error events.
 */
function parseSessionLogLine(raw: string): RawLogLine | null {
  if (!raw.trim()) return null;
  try {
    const rec = JSON.parse(raw);
    if (rec.event !== "tool_error") return null;
    const ts = rec.ts ? new Date(rec.ts) : new Date(0);
    return {
      ts,
      level: "ERROR",
      message: rec.error ?? rec.message ?? "tool error",
      source: "session-log",
      tool: rec.tool,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a ~/.ashlr/crashes/*.jsonl record into the shared RawLogLine shape
 * so crashes surface alongside normal errors in the aggregated report.
 */
function parseCrashDumpLine(raw: string): RawLogLine | null {
  if (!raw.trim()) return null;
  try {
    const rec = JSON.parse(raw);
    if (!rec || typeof rec !== "object") return null;
    const ts = rec.ts ? new Date(rec.ts) : new Date(0);
    const message = typeof rec.message === "string" && rec.message.length > 0
      ? rec.message
      : "handler crashed";
    return {
      ts,
      level: "ERROR",
      message,
      source: "session-log", // reuse existing source tag so tool breakdown includes crashes
      tool: typeof rec.tool === "string" ? rec.tool : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deduplication / normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an error message to a stable signature for deduplication.
 *
 * Strips:
 *   - Timestamps in various formats
 *   - Absolute paths → <path>
 *   - PIDs and numeric IDs → <N>
 *   - Hex strings / hashes → <hex>
 *   - IP addresses → <ip>
 *   - UUIDs → <uuid>
 *   - HTTP status codes remain (useful for grouping)
 *   - Collapses whitespace
 */
export function normalizeMessage(msg: string): string {
  return msg
    // ISO timestamps
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.,\d]*(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    // Unix timestamps (10 or 13 digits)
    .replace(/\b\d{10,13}\b/g, "<ts>")
    // UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    // Hex strings ≥ 8 chars (hashes, addresses)
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    // Absolute paths (Unix + Windows)
    .replace(/\/[^\s"']+/g, "<path>")
    .replace(/[A-Za-z]:\\[^\s"']*/g, "<path>")
    // IP addresses
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ip>")
    // Remaining standalone numbers > 3 digits (port-ish, PID-ish)
    .replace(/\b\d{4,}\b/g, "<N>")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function readLines(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, "utf8").split("\n");
  } catch {
    return [];
  }
}

function aggregateErrors(lines: RawLogLine[], windowMs: number, now: number): ErrorsReportData {
  const cutoff = now - windowMs;

  // Filter to window. Lines with epoch-0 ts (no timestamp found) are kept
  // only if the window is "all time" (cutoff ≤ 0). Otherwise they'd pollute
  // results — skip them silently.
  const inWindow = lines.filter((l) => {
    const t = l.ts.getTime();
    if (t === 0) return false; // unknown timestamp — exclude
    return t >= cutoff && t <= now;
  });

  if (inWindow.length === 0) {
    return {
      totalErrors: 0,
      uniqueSignatures: 0,
      windowHours: windowMs / 3_600_000,
      timeRangeStart: null,
      timeRangeEnd: null,
      topSignatures: [],
      toolBreakdown: [],
    };
  }

  // Signature map
  const sigMap = new Map<string, ErrorSignature>();
  for (const line of inWindow) {
    const sig = normalizeMessage(line.message);
    const existing = sigMap.get(sig);
    if (existing) {
      existing.count++;
      if (line.ts < existing.firstSeen) existing.firstSeen = line.ts;
      if (line.ts > existing.lastSeen) existing.lastSeen = line.ts;
    } else {
      sigMap.set(sig, {
        signature: sig,
        count: 1,
        firstSeen: line.ts,
        lastSeen: line.ts,
        sample: line.message.slice(0, 120),
      });
    }
  }

  // Tool breakdown from session-log tool_error events
  const toolMap = new Map<string, number>();
  for (const line of inWindow) {
    if (line.source === "session-log" && line.tool) {
      toolMap.set(line.tool, (toolMap.get(line.tool) ?? 0) + 1);
    }
  }

  const allTs = inWindow.map((l) => l.ts.getTime());
  const timeRangeStart = new Date(Math.min(...allTs));
  const timeRangeEnd = new Date(Math.max(...allTs));

  const topSignatures = [...sigMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const toolBreakdown = [...toolMap.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalErrors: inWindow.length,
    uniqueSignatures: sigMap.size,
    windowHours: windowMs / 3_600_000,
    timeRangeStart,
    timeRangeEnd,
    topSignatures,
    toolBreakdown,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function rule(): string {
  return "─".repeat(60);
}

function fmtDate(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function renderReport(data: ErrorsReportData): string {
  if (data.totalErrors === 0) {
    return [
      rule(),
      `  ashlr error report  ·  window: last ${data.windowHours}h`,
      rule(),
      "",
      `  (no errors recorded in the last ${data.windowHours}h)`,
      "",
      rule(),
    ].join("\n");
  }

  const parts: string[] = [];

  // Header
  parts.push(rule());
  parts.push(`  ashlr error report  ·  window: last ${data.windowHours}h`);
  parts.push(rule());
  parts.push("");
  parts.push(`  total errors        ${String(data.totalErrors).padStart(6)}`);
  parts.push(`  unique signatures   ${String(data.uniqueSignatures).padStart(6)}`);
  if (data.timeRangeStart && data.timeRangeEnd) {
    parts.push(`  from   ${fmtDate(data.timeRangeStart)}`);
    parts.push(`  to     ${fmtDate(data.timeRangeEnd)}`);
  }
  parts.push("");

  // Top signatures
  parts.push("  Top error signatures by frequency");
  parts.push("  " + "─".repeat(58));
  for (const sig of data.topSignatures) {
    const countCol = String(sig.count).padStart(5);
    parts.push(`  ${countCol}x  ${sig.sample}`);
    parts.push(`         first ${fmtDate(sig.firstSeen)}  last ${fmtDate(sig.lastSeen)}`);
    parts.push("");
  }

  // Per-tool breakdown
  if (data.toolBreakdown.length > 0) {
    parts.push("  Per-tool error breakdown (from session-log tool_error events)");
    parts.push("  " + "─".repeat(58));
    for (const { tool, count } of data.toolBreakdown) {
      parts.push(`  ${String(count).padStart(5)}x  ${tool}`);
    }
    parts.push("");
  }

  parts.push(rule());

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function buildErrorsReport(opts: ErrorsReportOptions = {}): string {
  const home = opts.home ?? process.env.HOME ?? homedir();
  const windowHours = opts.hours ?? 168;
  const now = opts.now ?? Date.now();
  const windowMs = windowHours * 3_600_000;

  const ashlrDir = join(home, ".ashlr");
  const logPath = join(ashlrDir, "ashlr.log");
  const logPath1 = join(ashlrDir, "ashlr.log.1");
  const sessionLogPath = join(ashlrDir, "session-log.jsonl");
  const crashesDir = join(ashlrDir, "crashes");

  // Collect raw lines from all sources
  const rawLines: RawLogLine[] = [];

  // ashlr.log + rotated .1
  for (const p of [logPath1, logPath]) {
    for (const line of readLines(p)) {
      const parsed = parseLogLine(line);
      if (parsed) rawLines.push(parsed);
    }
  }

  // session-log.jsonl tool_error events
  for (const line of readLines(sessionLogPath)) {
    const parsed = parseSessionLogLine(line);
    if (parsed) rawLines.push(parsed);
  }

  // crashes/*.jsonl — one record per handler crash (written by _tool-base.ts)
  if (existsSync(crashesDir)) {
    let files: string[] = [];
    try {
      files = readdirSync(crashesDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      files = [];
    }
    for (const f of files) {
      for (const line of readLines(join(crashesDir, f))) {
        const parsed = parseCrashDumpLine(line);
        if (parsed) rawLines.push(parsed);
      }
    }
  }

  const data = aggregateErrors(rawLines, windowMs, now);
  return renderReport(data);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.main) {
  // Parse --hours N
  let hours = 168;
  const argv = process.argv.slice(2);
  const hi = argv.indexOf("--hours");
  if (hi !== -1 && argv[hi + 1]) {
    const parsed = parseInt(argv[hi + 1], 10);
    if (!isNaN(parsed) && parsed > 0) hours = parsed;
  }

  try {
    process.stdout.write(buildErrorsReport({ hours }) + "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`errors-report failed: ${msg}\n`);
  }
  process.exit(0);
}
