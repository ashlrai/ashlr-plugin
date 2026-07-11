#!/usr/bin/env bun
/**
 * sessionend-hook-health-nudge.ts — Two SessionEnd nudges that surface
 * hook health to users who would otherwise never look at it:
 *
 *   1. Hook-error visibility (nudge #2) — if any hook wrote to
 *      ~/.ashlr/hook-errors.jsonl during this session, fire one nudge
 *      with a count + first 2 error summaries + link to
 *      `/ashlr-doctor --errors`. Silent failures hide real bugs;
 *      this makes them visible without spamming.
 *
 *   2. Hook regression detector (nudge #7) — if any hook in
 *      ~/.ashlr/hook-timings.jsonl breached a budget this session
 *      (p95 > 200ms OR max > 1s), fire one nudge with the offending
 *      hook names + link to `/ashlr-hook-timings --flags-only`.
 *
 * Both nudges:
 *   - Scope to "current session" via stats.json `sessions[*].startedAt`
 *     (no session-id in the jsonl rows; we approximate by `ts >= sessionStart`).
 *   - Throttle via ~/.ashlr/hook-health-nudge-state.json so the same
 *     category cannot re-fire within 24h across session boundaries.
 *   - Tail-read each jsonl (last 500 lines) so a very large file never
 *     blows past the SessionEnd 2s safety net (v1.29).
 *
 * Best-effort: any I/O error → null (no nudge). Never throws. Never blocks.
 * Output: prints nudge text(s) to stdout, separated by blank lines. Exits 0.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Thresholds + windows
// ---------------------------------------------------------------------------

/** p95 budget — anything above this triggers a regression nudge. */
export const REGRESSION_P95_MS = 200;
/** Max budget — a single sample over this triggers a regression nudge. */
export const REGRESSION_MAX_MS = 1000;
/** Minimum sample count for p95 to be meaningful. */
export const MIN_SAMPLES_FOR_P95 = 5;
/** Per-category throttle window (24h). */
export const THROTTLE_WINDOW_MS = 24 * 60 * 60_000;
/** Tail-read line cap — both jsonls. Keeps total scan budget well under 50ms. */
export const TAIL_LINES_CAP = 500;
/** Hard byte ceiling per tail read, independent of file size. */
export const TAIL_BYTES_CAP = 256 * 1024;
const TAIL_CHUNK_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface HealthNudgeState {
  /** Epoch ms of the last hook-error nudge (any). */
  last_error_nudge_at: number;
  /** Epoch ms of the last hook-regression nudge (any). */
  last_regression_nudge_at: number;
}

const defaultState = (): HealthNudgeState => ({
  last_error_nudge_at: 0,
  last_regression_nudge_at: 0,
});

export function healthNudgeStatePath(homeDir: string = homedir()): string {
  return join(homeDir, ".ashlr", "hook-health-nudge-state.json");
}

export function readHealthState(homeDir: string = homedir()): HealthNudgeState {
  try {
    const p = healthNudgeStatePath(homeDir);
    if (!existsSync(p)) return defaultState();
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<HealthNudgeState>;
    return {
      last_error_nudge_at:
        typeof raw.last_error_nudge_at === "number" ? raw.last_error_nudge_at : 0,
      last_regression_nudge_at:
        typeof raw.last_regression_nudge_at === "number" ? raw.last_regression_nudge_at : 0,
    };
  } catch {
    return defaultState();
  }
}

export function writeHealthState(
  state: HealthNudgeState,
  homeDir: string = homedir(),
): void {
  try {
    const dir = join(homeDir, ".ashlr");
    mkdirSync(dir, { recursive: true });
    const finalPath = healthNudgeStatePath(homeDir);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, finalPath);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Tail reader — bounded scan to respect 2s safety net
// ---------------------------------------------------------------------------

/**
 * Read the last `lineCap` lines of a JSONL file, parse each as JSON,
 * drop malformed lines. Returns [] if the file does not exist or fails to
 * read. Bounded to `lineCap` to protect against pathological files.
 */
export function tailJsonl<T = Record<string, unknown>>(
  path: string,
  lineCap: number = TAIL_LINES_CAP,
  byteCap: number = TAIL_BYTES_CAP,
): T[] {
  let fd: number | undefined;
  try {
    if (!existsSync(path)) return [];
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size === 0 || lineCap <= 0 || byteCap <= 0) return [];
    let position = size;
    let bytes = 0;
    let newlineCount = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && bytes < byteCap && newlineCount <= lineCap) {
      const length = Math.min(TAIL_CHUNK_BYTES, position, byteCap - bytes);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(fd, chunk, 0, length, position);
      if (read !== length) return [];
      chunks.unshift(chunk);
      bytes += read;
      for (const byte of chunk) if (byte === 10) newlineCount++;
    }
    let raw = Buffer.concat(chunks).toString("utf8");
    // Starting mid-file means the first bytes are a partial row.
    if (position > 0) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline === -1 ? "" : raw.slice(firstNewline + 1);
    }
    const allLines = raw.split("\n");
    const slice = allLines.filter((line) => line.trim()).slice(-lineCap);
    const out: T[] = [];
    for (const line of slice) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed: unknown = JSON.parse(t);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          out.push(parsed as T);
        }
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Session-start resolver — reuses stats.json (same as sessionend-savings-nudge)
// ---------------------------------------------------------------------------

interface StatsBucket {
  startedAt?: string;
  tokensSaved?: number;
}
interface StatsFile {
  sessions?: Record<string, StatsBucket>;
}

/**
 * Pick the most active session's startedAt as "current session". Falls back
 * to `now - 1h` when nothing is available — that bound keeps nudges
 * locally scoped while still finding records on a fresh install.
 */
export function resolveSessionStartMs(
  homeDir: string = homedir(),
  nowMs: number = Date.now(),
): number {
  try {
    const p = join(homeDir, ".ashlr", "stats.json");
    if (!existsSync(p)) return nowMs - 60 * 60_000;
    const stats = JSON.parse(readFileSync(p, "utf-8")) as StatsFile;
    let bestStart = "";
    let bestTokens = -1;
    for (const bucket of Object.values(stats.sessions ?? {})) {
      const tok = bucket.tokensSaved ?? 0;
      if (tok > bestTokens && typeof bucket.startedAt === "string") {
        bestTokens = tok;
        bestStart = bucket.startedAt;
      }
    }
    if (!bestStart) return nowMs - 60 * 60_000;
    const parsed = Date.parse(bestStart);
    return Number.isFinite(parsed) ? parsed : nowMs - 60 * 60_000;
  } catch {
    return nowMs - 60 * 60_000;
  }
}

// ---------------------------------------------------------------------------
// Nudge #2 — hook-error visibility
// ---------------------------------------------------------------------------

export interface HookErrorRecord {
  ts: string;
  hook: string;
  context: string;
  error: string;
}

export interface ErrorNudgeResult {
  nudgeText: string | null;
  count: number;
  errors: HookErrorRecord[];
}

/**
 * Pure: build the nudge text. Exported for tests.
 */
export function buildErrorNudge(count: number, errs: HookErrorRecord[]): string {
  const head =
    count === 1
      ? `1 hook error this session.`
      : `${count} hook errors this session.`;
  const lines: string[] = [head];
  for (const e of errs.slice(0, 2)) {
    // Trim very long error bodies so we don't dump a stack trace into the
    // SessionEnd channel. 120 chars is the same cap used by /ashlr-doctor.
    const trimmed = e.error.length > 120 ? e.error.slice(0, 117) + "..." : e.error;
    lines.push(`  • ${e.hook}: ${trimmed}`);
  }
  if (count > 2) lines.push(`  + ${count - 2} more`);
  lines.push("Run /ashlr-doctor --errors to inspect them.");
  return lines.join("\n");
}

/**
 * Compute the error nudge given current-session error records.
 */
export function computeErrorNudge(
  records: HookErrorRecord[],
  state: HealthNudgeState,
  nowMs: number,
): ErrorNudgeResult {
  if (records.length === 0) return { nudgeText: null, count: 0, errors: [] };
  // Throttle: same nudge category cannot re-fire within 24h.
  if (nowMs - state.last_error_nudge_at < THROTTLE_WINDOW_MS) {
    return { nudgeText: null, count: records.length, errors: records };
  }
  return {
    nudgeText: buildErrorNudge(records.length, records),
    count: records.length,
    errors: records,
  };
}

// ---------------------------------------------------------------------------
// Nudge #7 — hook regression detector
// ---------------------------------------------------------------------------

export interface HookTimingRow {
  ts: string;
  hook: string;
  tool?: string | null;
  durationMs: number;
  outcome: string;
}

export interface RegressionFinding {
  hook: string;
  p95: number;
  max: number;
  samples: number;
}

export interface RegressionNudgeResult {
  nudgeText: string | null;
  findings: RegressionFinding[];
}

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

export function buildRegressionNudge(findings: RegressionFinding[]): string {
  const names = findings.map((f) => f.hook).slice(0, 3).join(", ");
  const extra = findings.length > 3 ? ` (+${findings.length - 3} more)` : "";
  const detail = findings
    .slice(0, 3)
    .map((f) => {
      const parts: string[] = [];
      if (f.p95 > REGRESSION_P95_MS) parts.push(`p95 ${f.p95}ms`);
      if (f.max >= REGRESSION_MAX_MS) {
        const maxStr = f.max >= 1000 ? `${(f.max / 1000).toFixed(1)}s` : `${f.max}ms`;
        parts.push(`max ${maxStr}`);
      }
      return `  • ${f.hook} — ${parts.join(" · ")}`;
    })
    .join("\n");
  return [
    `Hook performance regressions this session: ${names}${extra}.`,
    detail,
    "Run /ashlr-hook-timings --flags-only for details.",
  ].join("\n");
}

/**
 * Compute regression findings + nudge. A hook is flagged when its
 * session-window p95 > 200ms (with ≥5 samples) OR its max ≥ 1000ms.
 */
export function computeRegressionNudge(
  records: HookTimingRow[],
  state: HealthNudgeState,
  nowMs: number,
): RegressionNudgeResult {
  if (records.length === 0) return { nudgeText: null, findings: [] };

  // Group by hook.
  const byHook = new Map<string, number[]>();
  for (const r of records) {
    const arr = byHook.get(r.hook) ?? [];
    arr.push(r.durationMs);
    byHook.set(r.hook, arr);
  }

  const findings: RegressionFinding[] = [];
  for (const [hook, durations] of byHook) {
    const sorted = [...durations].sort((a, b) => a - b);
    const max = sorted[sorted.length - 1] ?? 0;
    const p95 = sorted.length >= MIN_SAMPLES_FOR_P95 ? percentile(sorted, 95) : 0;
    const p95Breach = p95 > REGRESSION_P95_MS;
    const maxBreach = max >= REGRESSION_MAX_MS;
    if (p95Breach || maxBreach) {
      findings.push({ hook, p95, max, samples: sorted.length });
    }
  }

  if (findings.length === 0) return { nudgeText: null, findings: [] };

  // Sort worst-first by max then p95.
  findings.sort((a, b) => b.max - a.max || b.p95 - a.p95);

  if (nowMs - state.last_regression_nudge_at < THROTTLE_WINDOW_MS) {
    return { nudgeText: null, findings };
  }

  return { nudgeText: buildRegressionNudge(findings), findings };
}

// ---------------------------------------------------------------------------
// Orchestrator — read state, scan files, emit, persist
// ---------------------------------------------------------------------------

export interface FireResult {
  errorNudge: string | null;
  regressionNudge: string | null;
}

export function checkAndFireHealthNudges(
  homeDir: string = homedir(),
  nowMs: number = Date.now(),
): FireResult {
  try {
    const sessionStartMs = resolveSessionStartMs(homeDir, nowMs);
    const state = readHealthState(homeDir);

    // ----- Nudge #2: hook-errors -----
    const errPath = join(homeDir, ".ashlr", "hook-errors.jsonl");
    const allErrs = tailJsonl<HookErrorRecord>(errPath);
    const sessionErrs = allErrs.filter((e) => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t >= sessionStartMs;
    });
    const errorResult = computeErrorNudge(sessionErrs, state, nowMs);

    // ----- Nudge #7: hook regression -----
    let regressionResult: RegressionNudgeResult = { nudgeText: null, findings: [] };
    try {
      const timingsPath = join(homeDir, ".ashlr", "hook-timings.jsonl");
      const activeTimings = tailJsonl<HookTimingRow>(timingsPath, TAIL_LINES_CAP);
      const retainedTimings = activeTimings.length < TAIL_LINES_CAP
        ? tailJsonl<HookTimingRow>(`${timingsPath}.1`, TAIL_LINES_CAP - activeTimings.length)
        : [];
      const allTimings = [...retainedTimings, ...activeTimings];
      const sessionTimings = allTimings.filter((t) => {
        const ts = Date.parse(t.ts);
        return Number.isFinite(ts) && ts >= sessionStartMs;
      });
      regressionResult = computeRegressionNudge(sessionTimings, state, nowMs);
    } catch {
      // Timing corruption must not suppress an independently computed error nudge.
    }

    // Persist throttle state only when we actually emitted.
    const next: HealthNudgeState = { ...state };
    if (errorResult.nudgeText) next.last_error_nudge_at = nowMs;
    if (regressionResult.nudgeText) next.last_regression_nudge_at = nowMs;
    if (errorResult.nudgeText || regressionResult.nudgeText) {
      writeHealthState(next, homeDir);
    }

    return {
      errorNudge: errorResult.nudgeText,
      regressionNudge: regressionResult.nudgeText,
    };
  } catch {
    return { errorNudge: null, regressionNudge: null };
  }
}

// ---------------------------------------------------------------------------
// CLI entry — invoked by session-end-consolidate.ts
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { errorNudge, regressionNudge } = checkAndFireHealthNudges();
  const parts: string[] = [];
  if (errorNudge) parts.push(errorNudge);
  if (regressionNudge) parts.push(regressionNudge);
  if (parts.length > 0) {
    process.stdout.write("\n" + parts.join("\n\n") + "\n");
  }
  process.exit(0);
}
