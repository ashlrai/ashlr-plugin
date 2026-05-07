/**
 * read-calibration — loads the empirical grep multiplier from
 * ~/.ashlr/calibration.json (written by scripts/calibrate-grep.ts).
 *
 * Exports `getCalibrationMultiplier()` which efficiency-server.ts calls when
 * computing the "tokens saved" credit for genome-routed greps.
 *
 * Caching: the result is memoized for the process lifetime. The calibration
 * file is written rarely (only when the user explicitly runs calibrate-grep),
 * so re-reading on every tool call is wasteful.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Use process.env.HOME when set so test subprocesses on Windows can override
// the home directory (os.homedir() on Windows reads USERPROFILE, not HOME).
export const CALIBRATION_PATH = join(
  process.env.HOME ?? homedir(),
  ".ashlr",
  "calibration.json",
);

/** Default when no calibration has been run — conservative guess. */
export const DEFAULT_MULTIPLIER = 4;

export interface CalibrationFile {
  updatedAt: string;
  samples: CalibrationSample[];
  meanRatio: number;
  p50: number;
  p90: number;
  /** Mean ratio across only pattern-matched genome retrievals (excludes core-fallback + synthetic). */
  measuredMean?: number;
  /** Mean ratio across synthetic-only samples (no genome hit). */
  syntheticMean?: number;
  /** Number of samples that used a real pattern-matched genome retrieval. */
  measuredCount?: number;
  /** Mean ratio across core-fallback samples (genome present but pattern scored 0; constant-core output). */
  coreFallbackMean?: number;
  /** Number of samples that hit the core-fallback path. */
  coreFallbackCount?: number;
}

export interface CalibrationSample {
  cwd: string;
  pattern: string;
  rawBytes: number;
  compressedBytes: number;
  ratio: number;
  /**
   * "measured" — pattern scored > 0 against genome sections; compressedBytes is the real retrieval output.
   * "core-fallback" — pattern scored 0; compressedBytes is the constant core-section output (north-star + milestone).
   *   Reflects real ashlr__grep behavior for non-matching queries, but the ratio is dominated by the constant
   *   numerator, not pattern-specific compression.
   * "synthetic" — no genome present at all; compressedBytes = rawBytes / 4 (estimate, ratio always 4.0).
   */
  quality: "measured" | "core-fallback" | "synthetic";
}

// In-process cache so we pay the file read exactly once per MCP server
// lifetime. Set to `null` to force a re-read (tests can clear this).
let _cached: number | null = null;

/**
 * Returns the empirical mean ratio from ~/.ashlr/calibration.json, or
 * DEFAULT_MULTIPLIER if the file is absent or malformed.
 *
 * The returned value is the multiplier applied to the genome-compressed output
 * size to estimate what full ripgrep output would have cost.
 */
export function getCalibrationMultiplier(
  calibrationPath: string = CALIBRATION_PATH,
): number {
  // Return memoized value if already loaded (and using default path).
  if (_cached !== null && calibrationPath === CALIBRATION_PATH) {
    return _cached;
  }

  try {
    if (!existsSync(calibrationPath)) {
      _cached = DEFAULT_MULTIPLIER;
      return DEFAULT_MULTIPLIER;
    }
    const raw = readFileSync(calibrationPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).meanRatio !== "number" ||
      !Number.isFinite((parsed as Record<string, unknown>).meanRatio as number) ||
      ((parsed as Record<string, unknown>).meanRatio as number) <= 0
    ) {
      _cached = DEFAULT_MULTIPLIER;
      return DEFAULT_MULTIPLIER;
    }
    const file = parsed as CalibrationFile;
    // Preference order:
    //   1. measuredMean      — pattern-matched genome retrievals (best signal)
    //   2. coreFallbackMean  — real ashlr__grep output for non-matching queries
    //                          (still a measurement, just of the constant-core path)
    //   3. meanRatio         — overall, may be diluted by synthetic 4× estimates
    const isUsable = (n: unknown): n is number =>
      typeof n === "number" && Number.isFinite(n) && (n as number) > 0;
    const ratio = isUsable(file.measuredMean) && (file.measuredCount ?? 0) > 0
      ? file.measuredMean
      : isUsable(file.coreFallbackMean) && (file.coreFallbackCount ?? 0) > 0
        ? file.coreFallbackMean
        : file.meanRatio;
    if (calibrationPath === CALIBRATION_PATH) _cached = ratio;
    return ratio;
  } catch {
    if (calibrationPath === CALIBRATION_PATH) _cached = DEFAULT_MULTIPLIER;
    return DEFAULT_MULTIPLIER;
  }
}

/** Clear the in-process cache (useful in tests). */
export function clearCalibrationCache(): void {
  _cached = null;
}
