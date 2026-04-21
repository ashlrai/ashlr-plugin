#!/usr/bin/env bun
/**
 * ashlr hook-timings-report — reads ~/.ashlr/hook-timings.jsonl and renders
 * a compact per-hook latency table with p50/p95/max and error/block rates.
 *
 * Exported surface:
 *   readHookTimings(path?)        → HookTimingRecord[], fault-tolerant
 *   computeAggregates(records, windowHours?) → HookAggregate[]
 *
 * CLI: `bun run scripts/hook-timings-report.ts [--hours N]`
 *   Exits 0 always.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HookTimingRecord {
  ts: string;
  hook: string;
  tool: string | null;
  durationMs: number;
  outcome: "ok" | "bypass" | "block" | "error";
}

export interface HookAggregate {
  hook: string;
  calls: number;
  p50: number;
  p95: number;
  max: number;
  errorPct: number;
  blockPct: number;
}

// ---------------------------------------------------------------------------
// Reading + parsing
// ---------------------------------------------------------------------------

/**
 * Read and parse hook-timings.jsonl. Skips malformed lines silently.
 * @param path Override the default ~/.ashlr/hook-timings.jsonl path.
 */
export function readHookTimings(path?: string): HookTimingRecord[] {
  const resolved = path ?? join(homedir(), ".ashlr", "hook-timings.jsonl");
  if (!existsSync(resolved)) return [];
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf-8");
  } catch {
    return [];
  }
  const records: HookTimingRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (
        typeof obj.ts === "string" &&
        typeof obj.hook === "string" &&
        typeof obj.durationMs === "number" &&
        typeof obj.outcome === "string"
      ) {
        records.push({
          ts: obj.ts,
          hook: obj.hook,
          tool: typeof obj.tool === "string" ? obj.tool : null,
          durationMs: obj.durationMs,
          outcome: obj.outcome as HookTimingRecord["outcome"],
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return Math.round(sorted[lo]! + frac * (sorted[hi]! - sorted[lo]!));
}

/**
 * Compute per-hook aggregates, optionally filtered to the last N hours.
 * @param records Raw timing records.
 * @param windowHours Window in hours (default: 24). Pass Infinity for all.
 */
export function computeAggregates(
  records: HookTimingRecord[],
  windowHours = 24,
): HookAggregate[] {
  const cutoff = Date.now() - windowHours * 3_600_000;
  const inWindow = records.filter((r) => {
    const t = new Date(r.ts).getTime();
    return !isNaN(t) && t >= cutoff;
  });

  const byHook = new Map<string, HookTimingRecord[]>();
  for (const rec of inWindow) {
    const arr = byHook.get(rec.hook) ?? [];
    arr.push(rec);
    byHook.set(rec.hook, arr);
  }

  const aggregates: HookAggregate[] = [];
  for (const [hook, recs] of byHook) {
    const durations = recs.map((r) => r.durationMs).sort((a, b) => a - b);
    const errors = recs.filter((r) => r.outcome === "error").length;
    const blocks = recs.filter((r) => r.outcome === "block").length;
    aggregates.push({
      hook,
      calls: recs.length,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations[durations.length - 1] ?? 0,
      errorPct: (errors / recs.length) * 100,
      blockPct: (blocks / recs.length) * 100,
    });
  }

  return aggregates.sort((a, b) => b.calls - a.calls);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function fmtPct(pct: number, hasOutcome: boolean): string {
  if (!hasOutcome) return "—";
  return `${pct.toFixed(1)}%`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function medianOverAll(aggregates: HookAggregate[]): number {
  if (aggregates.length === 0) return 0;
  const total = aggregates.reduce((s, a) => s + a.calls, 0);
  if (total === 0) return 0;
  // weighted median approximation: sort all p50s by call count and pick mid
  const sorted = [...aggregates].sort((a, b) => a.p50 - b.p50);
  let acc = 0;
  const mid = total / 2;
  for (const a of sorted) {
    acc += a.calls;
    if (acc >= mid) return a.p50;
  }
  return sorted[sorted.length - 1]!.p50;
}

function buildFlags(aggregates: HookAggregate[]): string[] {
  const flags: string[] = [];
  for (const a of aggregates) {
    if (a.p95 > 100) {
      flags.push(
        `Flagging: ${a.hook} p95 > 100ms — consider parallelization.`,
      );
    }
    if (a.max >= 1000) {
      flags.push(
        `Flag: ${a.hook} max ${fmtMs(a.max)} — investigate slow path.`,
      );
    }
  }
  return flags;
}

export function renderReport(
  aggregates: HookAggregate[],
  windowHours: number,
  totalRecords: number,
): string {
  if (totalRecords === 0) {
    return "ashlr hook timings: no records yet (enable hooks and trigger a few tool calls).";
  }

  const med = medianOverAll(aggregates);
  const header = `ashlr hook timings · last ${windowHours}h · ${fmtNum(totalRecords)} records · median ${fmtMs(med)}`;

  // Column widths (must fit 80 cols total)
  // hook(22) calls(7) p50(7) p95(7) max(8) error%(8) block%(7) = ~66 + spaces
  const COL_HOOK = 22;
  const colHead =
    "hook".padEnd(COL_HOOK) +
    "calls".padStart(7) +
    "p50".padStart(7) +
    "p95".padStart(7) +
    "max".padStart(8) +
    "error%".padStart(8) +
    "block%".padStart(7);
  const rule = "─".repeat(70);

  const rows = aggregates.map((a) => {
    const hookCol = a.hook.length > COL_HOOK
      ? a.hook.slice(0, COL_HOOK - 1) + "…"
      : a.hook.padEnd(COL_HOOK);
    const hasErrors = a.calls > 0;
    const hasBlocks = a.calls > 0;
    return (
      hookCol +
      fmtNum(a.calls).padStart(7) +
      fmtMs(a.p50).padStart(7) +
      fmtMs(a.p95).padStart(7) +
      fmtMs(a.max).padStart(8) +
      fmtPct(a.errorPct, hasErrors).padStart(8) +
      fmtPct(a.blockPct, hasBlocks).padStart(7)
    );
  });

  const flags = buildFlags(aggregates);

  const parts = [header, "", colHead, rule, ...rows];
  if (flags.length > 0) {
    parts.push("", ...flags);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Public top-level builder
// ---------------------------------------------------------------------------

export function buildHookTimingsReport(opts: {
  path?: string;
  hours?: number;
  now?: number;
} = {}): string {
  const hours = opts.hours ?? 24;
  const records = readHookTimings(opts.path);
  const aggregates = computeAggregates(records, hours);
  const totalRecords = aggregates.reduce((s, a) => s + a.calls, 0);
  return renderReport(aggregates, hours, totalRecords);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.main) {
  let hours = 24;
  const argv = process.argv.slice(2);
  const hi = argv.indexOf("--hours");
  if (hi !== -1 && argv[hi + 1]) {
    const parsed = parseInt(argv[hi + 1]!, 10);
    if (!isNaN(parsed) && parsed > 0) hours = parsed;
  }

  try {
    process.stdout.write(buildHookTimingsReport({ hours }) + "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`hook-timings-report failed: ${msg}\n`);
  }
  process.exit(0);
}
