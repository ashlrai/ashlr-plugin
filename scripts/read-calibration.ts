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
}

export interface CalibrationSample {
  cwd: string;
  pattern: string;
  rawBytes: number;
  compressedBytes: number;
  ratio: number;
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
    const ratio = (parsed as CalibrationFile).meanRatio;
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
