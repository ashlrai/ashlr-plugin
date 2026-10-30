#!/usr/bin/env bun
/**
 * ashlr session-log report — reads ~/.ashlr/session-log.jsonl (+ rotated .1)
 * and produces a plain-text usage report.
 *
 * Exported surface:
 *   buildReport(opts?)  → formatted string, never throws.
 *
 * CLI: `bun run scripts/session-log-report.ts`
 *   Exits 0 always. Emits "no activity recorded yet" when log is absent.
 */

import { existsSync, readFileSync } from "fs";
import { basename } from "path";
import { homedir } from "os";
import { join } from "path";
import { formatTokens } from "./savings-status-line.ts";

// ---------------------------------------------------------------------------
// Schema
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
  // session_end extras
  calls?: number;
  tokens_saved?: number;
  started_at?: string;
  // fallback/escalate/noop extras (from _events.ts)
  reason?: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BuildReportOpts {
  /** Override home dir — used by tests to point at a tmp dir. */
  home?: string;
  /** Max lines to read per file (default: unlimited). */
  limitLines?: number;
  /** How many hours to consider "recent" for the 24h window (default: 24). */
  windowHours?: number;
  /** Injected now in ms — tests pin this. */
  now?: number;
}

// ---------------------------------------------------------------------------
// JSONL reader
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
      // Require at minimum ts + event to be parseable.
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
// Math helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2));
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function fmtDuration(ms: number): string {
  if (ms < 0) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function shortSession(id: string): string {
  if (!id || id.length <= 8) return id || "?";
  return id.slice(0, 8) + "...";
}

// ---------------------------------------------------------------------------
// Formatting / layout
// ---------------------------------------------------------------------------

const WIDTH = 78;

function rule(char = "-"): string {
  return char.repeat(WIDTH);
}

function section(title: string): string {
  const pad = Math.max(0, WIDTH - title.length - 4);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return `${"─".repeat(left)}  ${title}  ${"─".repeat(right)}`;
}

/** Right-align `value` within a fixed column; truncate label if needed. */
function row(label: string, value: string, labelWidth = 32): string {
  const lbl = label.length > labelWidth ? label.slice(0, labelWidth - 1) + "…" : label.padEnd(labelWidth);
  return `${lbl}  ${value}`;
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

interface ToolStat {
  calls: number;
  inputSizes: number[];
  outputSizes: number[];
}

interface ProjectStat {
  calls: number;
  tools: Set<string>;
}

interface SessionEndStat {
  session: string;
  calls: number;
  tokensSaved: number;
  startedAt: string;
  endedAt: string;
}

// Fallback/escalation/noop event kinds emitted by _events.ts
const FALLBACK_EVENTS = new Set(["tool_fallback", "tool_escalate", "tool_noop"]);

interface FallbackStat {
  /** Total occurrences of this (tool, event, reason) triple. */
  count: number;
}

interface Aggregated {
  total: number;
  sessions: Set<string>;
  projects: Set<string>;
  earliest: number;
  latest: number;
  tools: Map<string, ToolStat>;
  projectMap: Map<string, ProjectStat>;
  windowCalls: number;
  windowTools: Set<string>;
  sessionEnds: SessionEndStat[];
  /** tool → { event:reason → count } */
  fallbackByTool: Map<string, Map<string, FallbackStat>>;
  /** reason → count (across all tools, for top-3 reasons) */
  fallbackReasons: Map<string, number>;
  /** total fallback/escalate/noop events */
  fallbackTotal: number;
}

function aggregate(records: LogRecord[], windowMs: number, now: number): Aggregated {
  const agg: Aggregated = {
    total: 0,
    sessions: new Set(),
    projects: new Set(),
    earliest: Infinity,
    latest: -Infinity,
    tools: new Map(),
    projectMap: new Map(),
    windowCalls: 0,
    windowTools: new Set(),
    sessionEnds: [],
    fallbackByTool: new Map(),
    fallbackReasons: new Map(),
    fallbackTotal: 0,
  };

  const windowStart = now - windowMs;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  for (const r of records) {
    const ts = Date.parse(r.ts);
    if (!Number.isFinite(ts)) continue;

    if (r.event === "session_end") {
      if (ts >= sevenDaysAgo) {
        agg.sessionEnds.push({
          session: r.session,
          calls: r.calls ?? 0,
          tokensSaved: r.tokens_saved ?? 0,
          startedAt: r.started_at ?? r.ts,
          endedAt: r.ts,
        });
      }
      continue;
    }

    // Fallback/escalate/noop events from _events.ts
    if (FALLBACK_EVENTS.has(r.event)) {
      agg.fallbackTotal++;
      const toolKey = r.tool || "unknown";
      const reason = r.reason ?? "unknown";
      const eventReason = `${r.event}:${reason}`;

      let toolMap = agg.fallbackByTool.get(toolKey);
      if (!toolMap) {
        toolMap = new Map();
        agg.fallbackByTool.set(toolKey, toolMap);
      }
      const existing = toolMap.get(eventReason);
      if (existing) {
        existing.count++;
      } else {
        toolMap.set(eventReason, { count: 1 });
      }

      agg.fallbackReasons.set(reason, (agg.fallbackReasons.get(reason) ?? 0) + 1);
      continue;
    }

    // tool_call records
    agg.total++;
    if (r.session) agg.sessions.add(r.session);
    if (r.cwd) agg.projects.add(r.cwd);
    if (ts < agg.earliest) agg.earliest = ts;
    if (ts > agg.latest) agg.latest = ts;

    // per-tool
    const toolKey = r.tool || "unknown";
    let ts2 = agg.tools.get(toolKey);
    if (!ts2) {
      ts2 = { calls: 0, inputSizes: [], outputSizes: [] };
      agg.tools.set(toolKey, ts2);
    }
    ts2.calls++;
    if (r.input_size > 0) ts2.inputSizes.push(r.input_size);
    if (r.output_size > 0) ts2.outputSizes.push(r.output_size);

    // per-project
    if (r.cwd) {
      let ps = agg.projectMap.get(r.cwd);
      if (!ps) {
        ps = { calls: 0, tools: new Set() };
        agg.projectMap.set(r.cwd, ps);
      }
      ps.calls++;
      ps.tools.add(toolKey);
    }

    // window
    if (ts >= windowStart) {
      agg.windowCalls++;
      agg.windowTools.add(toolKey);
    }
  }

  return agg;
}

// ---------------------------------------------------------------------------
// Report sections
// ---------------------------------------------------------------------------

function renderHeader(agg: Aggregated): string {
  const lines: string[] = [];
  lines.push(section("SESSION LOG REPORT"));

  const timeRange =
    agg.total === 0
      ? "no data"
      : `${new Date(agg.earliest).toISOString().slice(0, 16).replace("T", " ")} ` +
        `-> ${new Date(agg.latest).toISOString().slice(0, 16).replace("T", " ")}`;

  lines.push(row("total tool calls", String(agg.total)));
  lines.push(row("unique sessions", String(agg.sessions.size)));
  lines.push(row("unique projects (cwd)", String(agg.projects.size)));
  lines.push(row("log time range", timeRange));
  return lines.join("\n");
}

function renderTopTools(agg: Aggregated): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(section("TOP TOOLS  (by call count, top 10)"));

  const sorted = [...agg.tools.entries()]
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 10);

  if (sorted.length === 0) {
    lines.push("  no tool calls recorded");
    return lines.join("\n");
  }

  lines.push(
    row("tool", "calls   med-in    med-out", 28),
  );
  lines.push(rule("·"));

  for (const [name, stat] of sorted) {
    const medIn = fmtBytes(median(stat.inputSizes));
    const medOut = fmtBytes(median(stat.outputSizes));
    const label = name.length > 26 ? name.slice(0, 25) + "…" : name;
    const vals = `${String(stat.calls).padStart(5)}   ${medIn.padStart(7)}   ${medOut.padStart(7)}`;
    lines.push(row(label, vals, 28));
  }

  return lines.join("\n");
}

function renderProjects(agg: Aggregated): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(section("PER-PROJECT BREAKDOWN  (top 5 by call count)"));

  const sorted = [...agg.projectMap.entries()]
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 5);

  if (sorted.length === 0) {
    lines.push("  no project data recorded");
    return lines.join("\n");
  }

  lines.push(row("project", "calls   tools", 36));
  lines.push(rule("·"));

  for (const [path, stat] of sorted) {
    const name = basename(path) || path;
    const truncated = name.length > 34 ? "…" + name.slice(-(33)) : name;
    const vals = `${String(stat.calls).padStart(5)}   ${String(stat.tools.size).padStart(5)}`;
    lines.push(row(truncated, vals, 36));
  }

  return lines.join("\n");
}

function renderWindow(agg: Aggregated, windowHours: number, now: number): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(section(`LAST ${windowHours}H vs LIFETIME`));

  // Approximate tokens: treat each byte of output as ~0.25 tokens (rough heuristic).
  // We don't have token counts in tool_call records — this is an approximation.
  let lifetimeOutBytes = 0;
  let windowOutBytes = 0;

  const windowStart = now - windowHours * 60 * 60 * 1000;

  // Recalculate per-record for accuracy (agg already processed but we need
  // per-record window split for bytes).
  // We approximate: use tool stat output sizes. For window, scale proportionally
  // by window_calls / total_calls.
  for (const stat of agg.tools.values()) {
    const total = stat.outputSizes.reduce((s, v) => s + v, 0);
    lifetimeOutBytes += total;
  }
  // Scale for window approximate
  const windowRatio = agg.total > 0 ? agg.windowCalls / agg.total : 0;
  windowOutBytes = Math.round(lifetimeOutBytes * windowRatio);

  const lifetimeTokApprox = Math.round(lifetimeOutBytes / 4);
  const windowTokApprox = Math.round(windowOutBytes / 4);

  const colW = 16;
  const col1 = `last ${windowHours}h`.padEnd(colW);
  const col2 = "lifetime".padEnd(colW);
  lines.push(`  ${"".padEnd(20)}  ${col1}${col2}`);
  lines.push(rule("·"));
  lines.push(`  ${"calls".padEnd(20)}  ${String(agg.windowCalls).padEnd(colW)}${String(agg.total)}`);
  lines.push(`  ${"tokens (approx)".padEnd(20)}  ${formatTokens(windowTokApprox).padEnd(colW)}${formatTokens(lifetimeTokApprox)}`);
  lines.push(`  ${"tools used".padEnd(20)}  ${String(agg.windowTools.size).padEnd(colW)}${String(agg.tools.size)}`);

  return lines.join("\n");
}

function renderFallbackRates(agg: Aggregated): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(section("FALLBACK & ESCALATION RATES"));

  if (agg.fallbackTotal === 0) {
    lines.push("  (none recorded)");
    return lines.join("\n");
  }

  // Per-tool rows: tool | event:reason | count | % of tool_calls for that tool
  lines.push(row("tool  event:reason", "count    % of calls", 38));
  lines.push(rule("·"));

  for (const [tool, eventMap] of [...agg.fallbackByTool.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const toolCalls = agg.tools.get(tool)?.calls ?? 0;
    for (const [eventReason, stat] of [...eventMap.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const label = `${tool}  ${eventReason}`;
      const truncated = label.length > 36 ? "…" + label.slice(-(35)) : label;
      const pctStr = toolCalls > 0
        ? `${Math.round((stat.count / toolCalls) * 100)}%`
        : "n/a";
      const vals = `${String(stat.count).padStart(5)}    ${pctStr.padStart(8)}`;
      lines.push(row(truncated, vals, 38));
    }
  }

  // Top 3 reasons across all tools
  lines.push("");
  lines.push("  top reasons:");
  const topReasons = [...agg.fallbackReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [reason, count] of topReasons) {
    lines.push(`    ${reason.padEnd(28)}  ${count}`);
  }

  return lines.join("\n");
}

function renderSessionEnds(agg: Aggregated): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(section("SESSION SUMMARY  (last 7 days, session_end events)"));

  if (agg.sessionEnds.length === 0) {
    lines.push("  no session_end records in last 7 days");
    return lines.join("\n");
  }

  lines.push(row("session", "duration    calls  tokens-saved", 14));
  lines.push(rule("·"));

  // Sort most recent first.
  const sorted = [...agg.sessionEnds].sort(
    (a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt),
  );

  for (const s of sorted) {
    const startMs = Date.parse(s.startedAt);
    const endMs = Date.parse(s.endedAt);
    const dur = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? fmtDuration(endMs - startMs)
      : "?";
    const tok = formatTokens(s.tokensSaved);
    const vals = `${dur.padEnd(10)}  ${String(s.calls).padStart(5)}  ${tok.padStart(12)}`;
    lines.push(row(shortSession(s.session), vals, 14));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildReport(opts: BuildReportOpts = {}): string {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const windowHours = opts.windowHours ?? 24;
  const windowMs = windowHours * 60 * 60 * 1000;

  const logPath = join(home, ".ashlr", "session-log.jsonl");
  const rotatedPath = join(home, ".ashlr", "session-log.jsonl.1");

  const lines1 = readLines(rotatedPath, opts.limitLines);
  const lines2 = readLines(logPath, opts.limitLines);
  const allLines = [...lines1, ...lines2];

  if (allLines.length === 0) {
    return [
      section("SESSION LOG REPORT"),
      "",
      "  no activity recorded yet.",
      "  Use ashlr__read, ashlr__grep, and ashlr__edit to start accumulating data.",
      `  Log path: ${logPath}`,
      "",
      rule(),
    ].join("\n");
  }

  const records = parseRecords(allLines);
  const agg = aggregate(records, windowMs, now);

  const parts: string[] = [
    renderHeader(agg),
    renderTopTools(agg),
    renderProjects(agg),
    renderWindow(agg, windowHours, now),
    renderFallbackRates(agg),
    renderSessionEnds(agg),
    "",
    rule(),
    `  log: ${logPath}`,
  ];

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    process.stdout.write(buildReport() + "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`session-log-report failed: ${msg}\n`);
  }
  process.exit(0);
}
