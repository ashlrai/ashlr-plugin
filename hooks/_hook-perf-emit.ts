#!/usr/bin/env bun
/**
 * _hook-perf-emit.ts — SessionEnd helper: read hook-timings.jsonl,
 * compute per-hook p50/p99, and emit one `hook_perf` telemetry event per hook.
 *
 * Called from session-end-consolidate.ts (fire-and-forget). Also exported
 * for direct use in tests and future callers.
 *
 * Privacy: only hook names and latency percentiles are emitted — no file
 * paths, no tool arguments, no content.
 */

import { readHookTimings, computeAggregates } from "../scripts/hook-timings-report";
import { logHookPerfEvent, isTelemetryEnabled } from "../servers/_telemetry";

// ---------------------------------------------------------------------------
// p99 helper (computeAggregates only exposes p95; we need p99 for the spec)
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HookPerfSummary {
  hook_name: string;
  p50_ms: number;
  p99_ms: number;
  count: number;
}

/**
 * Read hook-timings.jsonl from `timingsPath` (default: ~/.ashlr/hook-timings.jsonl),
 * compute per-hook p50/p99 over the last `windowHours` hours, and return summaries.
 */
export function computeHookPerfSummaries(opts: {
  timingsPath?: string;
  windowHours?: number;
} = {}): HookPerfSummary[] {
  const { timingsPath, windowHours = 24 } = opts;
  const records = readHookTimings(timingsPath);
  if (records.length === 0) return [];

  // Use computeAggregates for the p50 + grouping, then recompute p99
  // from the raw records since the aggregate only exposes p95.
  const aggregates = computeAggregates(records, windowHours);

  // Build a map: hook → sorted durations (within the window)
  const cutoff = Date.now() - windowHours * 3_600_000;
  const byHook = new Map<string, number[]>();
  for (const rec of records) {
    const t = new Date(rec.ts).getTime();
    if (isNaN(t) || t < cutoff) continue;
    const arr = byHook.get(rec.hook) ?? [];
    arr.push(rec.durationMs);
    byHook.set(rec.hook, arr);
  }

  return aggregates.map((agg) => {
    const durations = (byHook.get(agg.hook) ?? []).sort((a, b) => a - b);
    return {
      hook_name: agg.hook,
      p50_ms: agg.p50,
      p99_ms: percentile(durations, 99),
      count: agg.calls,
    };
  });
}

/**
 * Emit one `hook_perf` telemetry event per hook. No-op when telemetry is off.
 * Returns the number of events emitted (0 when telemetry off or no records).
 */
export function emitHookPerfEvents(opts: {
  timingsPath?: string;
  windowHours?: number;
  homeDir?: string;
} = {}): number {
  if (!isTelemetryEnabled(opts.homeDir)) return 0;
  const summaries = computeHookPerfSummaries(opts);
  for (const s of summaries) {
    logHookPerfEvent({
      hook_name: s.hook_name,
      p50_ms: s.p50_ms,
      p99_ms: s.p99_ms,
      count: s.count,
    }, opts.homeDir);
  }
  return summaries.length;
}

// ---------------------------------------------------------------------------
// CLI entry (called from session-end-consolidate.ts as fire-and-forget)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    emitHookPerfEvents();
  } catch {
    // best-effort — never disturb session exit
  }
  process.exit(0);
}
