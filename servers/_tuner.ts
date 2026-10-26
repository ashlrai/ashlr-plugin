/**
 * _tuner.ts: per-repo self-tuning of compression detail (self-tuning P2).
 *
 * Input: miss counts from _miss-tracker (per repo, per ashlr tool + extension).
 * Output: a bounded detail level per pair. Positive = keep more detail
 * (misses are frequent), negative = compress harder (misses are rare), 0 = default.
 *
 * Bounds:
 *   - level stays within [MIN_DETAIL, MAX_DETAIL]
 *   - no change until a pair has MIN_SAMPLES compressed results
 *   - at most STEP per MIN_SAMPLES new results (small steps, no oscillation storms)
 *   - between LOW_MISS_RATE and HIGH_MISS_RATE nothing moves (hysteresis)
 *
 * On by default; ASHLR_TUNING=off makes every level 0 and stops updates.
 * Local only, counts only. Best-effort, never throws.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import { sha8 } from "./_history-tracker";
import { type MissCounts, readMissStats, trackingEnabled } from "./_miss-tracker";

export const MIN_DETAIL = -2;
export const MAX_DETAIL = 2;
export const STEP = 1;
export const MIN_SAMPLES = 20;
export const HIGH_MISS_RATE = 0.25;
export const LOW_MISS_RATE = 0.05;

export interface PairState { level: number; atSample: number }
export type TuningState = Record<string, Record<string, PairState>>;

const clamp = (n: number) => Math.max(MIN_DETAIL, Math.min(MAX_DETAIL, n));

/** Pure step function: next state for one tool+extension pair. */
export function nextPairState(prev: PairState | undefined, c: MissCounts): PairState {
  const cur: PairState = prev ? { level: clamp(prev.level), atSample: prev.atSample } : { level: 0, atSample: 0 };
  if (c.compressed < MIN_SAMPLES || c.compressed - cur.atSample < MIN_SAMPLES) return cur;
  const rate = c.misses / c.compressed;
  let dir = 0;
  if (rate >= HIGH_MISS_RATE) dir = STEP;
  else if (rate <= LOW_MISS_RATE) dir = -STEP;
  if (dir === 0) return cur;
  return { level: clamp(cur.level + dir), atSample: c.compressed };
}

export function tuningPath(homeDir: string, cwd: string = process.cwd()): string {
  return join(homeDir, ".ashlr", "tuning", `${sha8(resolve(cwd))}.json`);
}

export function readTuning(homeDir: string, cwd: string = process.cwd()): TuningState {
  try {
    const p = tuningPath(homeDir, cwd);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as TuningState) : {};
  } catch {
    return {};
  }
}

/** Recompute and persist tuning for this repo from its miss stats. */
export function tuneRepo(homeDir: string, cwd: string = process.cwd()): TuningState {
  if (!trackingEnabled()) return {};
  try {
    const stats = readMissStats(homeDir, cwd);
    const prev = readTuning(homeDir, cwd);
    const next: TuningState = {};
    for (const [tool, exts] of Object.entries(stats)) {
      for (const [ext, c] of Object.entries(exts)) {
        (next[tool] ??= {})[ext] = nextPairState(prev[tool]?.[ext], c);
      }
    }
    const p = tuningPath(homeDir, cwd);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(next), "utf-8");
    return next;
  } catch {
    return {};
  }
}

/** Detail level a compressor should apply for this tool + extension (0 when off). */
export function tunedDetail(tool: string, ext: string, homeDir: string, cwd: string = process.cwd()): number {
  if (!trackingEnabled()) return 0;
  return clamp(readTuning(homeDir, cwd)[tool]?.[ext.toLowerCase()]?.level ?? 0);
}

/** Each detail level multiplies a compressor's byte budget by this factor. */
export const DETAIL_FACTOR = 1.5;

/** Budget multiplier for a detail level: 1 at level 0, bounded by MIN/MAX_DETAIL. */
export function budgetScale(level: number): number {
  const l = clamp(Math.trunc(level) || 0);
  return l === 0 ? 1 : DETAIL_FACTOR ** l;
}

/**
 * Summarize threshold for a tool + extension under the current tuning, or
 * undefined at level 0 (callers then pass nothing, keeping today's behavior).
 */
export function tunedThreshold(
  tool: string,
  ext: string,
  baseBytes: number,
  homeDir: string,
  cwd: string = process.cwd(),
): number | undefined {
  const scale = budgetScale(tunedDetail(tool, ext || "(none)", homeDir, cwd));
  return scale === 1 ? undefined : Math.round(baseBytes * scale);
}
