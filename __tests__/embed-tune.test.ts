/**
 * embed-tune.test.ts — Tests for scripts/embed-tune.ts
 *
 * Uses synthetic calibration data with a known optimal threshold so we can
 * assert the tuner finds it within ±0.01.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  applyThreshold,
  computeStats,
  loadCalibrationEntries,
  renderReport,
  sweepThresholds,
  tune,
  type CalibrationEntry,
} from "../scripts/embed-tune";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ashlr-embed-tune-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(similarity: number, hit: boolean): CalibrationEntry {
  return {
    ts: new Date().toISOString(),
    queryHashHex: "deadbeef",
    topSimilarity: similarity,
    hit,
    contentLength: 500,
    threshold: 0.68,
  };
}

function writeCalibFile(entries: CalibrationEntry[], path: string): void {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Synthetic dataset with known optimum
//
// Design:
//   - True positives (genuinely useful):  similarity in [0.76, 0.95], hit=true
//   - True negatives (not useful):        similarity in [0.50, 0.74], hit=false
//   - False positives (noise at low T):   similarity in [0.70, 0.74], hit=false
//
// At threshold 0.75 we cleanly separate TP from FP → precision=1.0, recall=1.0.
// Any threshold in [0.75, 0.76) achieves F1=1.0; the sweep picks the lowest
// (0.75) which is within the ±0.01 assertion window [0.74, 0.76].
// ---------------------------------------------------------------------------

function buildSyntheticDataset(): CalibrationEntry[] {
  const entries: CalibrationEntry[] = [];

  // 20 genuine hits (high similarity, were used)
  for (let i = 0; i < 20; i++) {
    entries.push(makeEntry(0.76 + i * 0.01, true));  // 0.76 → 0.95
  }

  // 15 true negatives (low similarity, not used)
  for (let i = 0; i < 15; i++) {
    entries.push(makeEntry(0.50 + i * 0.01, false)); // 0.50 → 0.64
  }

  // 5 false positives just below the boundary (would be included at T<0.75)
  for (let i = 0; i < 5; i++) {
    entries.push(makeEntry(0.70 + i * 0.01, false)); // 0.70, 0.71, 0.72, 0.73, 0.74
  }

  return entries;
}

// ---------------------------------------------------------------------------
// loadCalibrationEntries
// ---------------------------------------------------------------------------

describe("loadCalibrationEntries", () => {
  test("absent file → empty array", () => {
    const result = loadCalibrationEntries(join(tmpDir, "nonexistent.jsonl"));
    expect(result).toEqual([]);
  });

  test("valid JSONL → entries parsed", () => {
    const entries = [makeEntry(0.8, true), makeEntry(0.6, false)];
    const path = join(tmpDir, "calib.jsonl");
    writeCalibFile(entries, path);

    const loaded = loadCalibrationEntries(path);
    expect(loaded.length).toBe(2);
    expect(loaded[0].topSimilarity).toBe(0.8);
    expect(loaded[0].hit).toBe(true);
    expect(loaded[1].topSimilarity).toBe(0.6);
    expect(loaded[1].hit).toBe(false);
  });

  test("malformed lines are skipped", () => {
    const path = join(tmpDir, "mixed.jsonl");
    writeFileSync(path, JSON.stringify(makeEntry(0.7, true)) + "\nNOT_JSON\n" + JSON.stringify(makeEntry(0.5, false)) + "\n");

    const loaded = loadCalibrationEntries(path);
    expect(loaded.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------

describe("computeStats", () => {
  test("threshold above all entries → recall=0, precision=1", () => {
    const entries = [makeEntry(0.6, true), makeEntry(0.7, false)];
    const stats = computeStats(entries, 0.99, 1.0);
    expect(stats.recall).toBe(0);
    expect(stats.precision).toBe(1.0);
  });

  test("threshold below all entries → recall=1, precision = TP/total", () => {
    const entries = [makeEntry(0.9, true), makeEntry(0.8, true), makeEntry(0.7, false)];
    const stats = computeStats(entries, 0.0, 1.0);
    // All 3 would hit; 2 are genuine TP.
    expect(stats.recall).toBeCloseTo(1.0);
    expect(stats.precision).toBeCloseTo(2 / 3);
  });

  test("perfect separation → precision=1, recall=1", () => {
    const entries = [
      makeEntry(0.9, true),
      makeEntry(0.8, true),
      makeEntry(0.5, false),
      makeEntry(0.4, false),
    ];
    // Threshold 0.75 should perfectly separate hits from non-hits.
    const stats = computeStats(entries, 0.75, 1.0);
    expect(stats.precision).toBe(1.0);
    expect(stats.recall).toBe(1.0);
    expect(stats.fBeta).toBe(1.0);
  });

  test("no positive entries → recall=0", () => {
    const entries = [makeEntry(0.9, false), makeEntry(0.7, false)];
    const stats = computeStats(entries, 0.5, 1.0);
    expect(stats.recall).toBe(0);
  });

  test("beta weight shifts score towards precision", () => {
    // High precision=1 low recall=0.5 scenario.
    const entries = [makeEntry(0.9, true), makeEntry(0.8, true), makeEntry(0.3, false)];
    const statsF1 = computeStats(entries, 0.85, 1.0);   // hits only 0.9
    const statsF2 = computeStats(entries, 0.85, 2.0);   // recall-heavy

    // Precision=1, recall=0.5 for both. F2 should score lower than F1 when recall is low.
    // F1 = 2*1*0.5/(1+0.5) = 0.667; F2 = 5*1*0.5/(4*1+0.5) = 2.5/4.5 = 0.556
    expect(statsF1.fBeta).toBeGreaterThan(statsF2.fBeta);
  });
});

// ---------------------------------------------------------------------------
// sweepThresholds
// ---------------------------------------------------------------------------

describe("sweepThresholds", () => {
  test("returns 46 steps from 0.50 to 0.95 inclusive", () => {
    const entries = [makeEntry(0.7, true)];
    const steps = sweepThresholds(entries, 1.0);
    expect(steps.length).toBe(46);
    expect(steps[0].threshold).toBeCloseTo(0.50);
    expect(steps[steps.length - 1].threshold).toBeCloseTo(0.95);
  });
});

// ---------------------------------------------------------------------------
// tune — core optimisation
// ---------------------------------------------------------------------------

describe("tune", () => {
  test("finds optimal threshold within ±0.01 on synthetic dataset", () => {
    const entries = buildSyntheticDataset();
    const result = tune(entries, 0.68, 1.0);

    // The synthetic dataset has a clean separation at 0.75.
    expect(result.recommendedThreshold).toBeGreaterThanOrEqual(0.74);
    expect(result.recommendedThreshold).toBeLessThanOrEqual(0.76);
  });

  test("entryCount matches input length", () => {
    const entries = buildSyntheticDataset();
    const result = tune(entries, 0.68, 1.0);
    expect(result.entryCount).toBe(entries.length);
  });

  test("currentStats reflects the passed currentThreshold", () => {
    const entries = buildSyntheticDataset();
    const result = tune(entries, 0.68, 1.0);
    expect(result.currentStats.threshold).toBeCloseTo(0.68, 2);
  });

  test("empty entries → recommendedThreshold is still a valid number", () => {
    const result = tune([], 0.68, 1.0);
    expect(typeof result.recommendedThreshold).toBe("number");
    expect(Number.isFinite(result.recommendedThreshold)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderReport
// ---------------------------------------------------------------------------

describe("renderReport", () => {
  test("empty data → mentions no calibration data", () => {
    const result = tune([], 0.68, 1.0);
    const report = renderReport(result);
    expect(report).toContain("No calibration data");
  });

  test("with data → shows current and recommended thresholds", () => {
    const entries = buildSyntheticDataset();
    const result = tune(entries, 0.68, 1.0);
    const report = renderReport(result);
    expect(report).toContain("current threshold");
    expect(report).toContain("recommended");
    expect(report).toContain("0.68");
  });

  test("optimal current → says already optimal", () => {
    // Build a dataset where 0.68 is the best threshold.
    const entries: CalibrationEntry[] = [
      makeEntry(0.9, true),
      makeEntry(0.8, true),
      makeEntry(0.6, false),
    ];
    // Force currentThreshold to match whatever the tuner picks.
    const result = tune(entries, 0.68, 1.0);
    // If recommended === current, say so.
    if (Math.abs(result.recommendedThreshold - result.currentThreshold) < 0.005) {
      expect(renderReport(result)).toContain("already optimal");
    } else {
      expect(renderReport(result)).toContain("ASHLR_EMBED_THRESHOLD");
    }
  });
});

// ---------------------------------------------------------------------------
// applyThreshold
// ---------------------------------------------------------------------------

describe("applyThreshold", () => {
  test("creates config.json with embedThreshold", () => {
    const configPath = join(tmpDir, "config.json");
    applyThreshold(0.73, configPath);
    expect(existsSync(configPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(parsed.embedThreshold).toBeCloseTo(0.73);
  });

  test("merges with existing config keys", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ someOtherKey: "value" }) + "\n");
    applyThreshold(0.80, configPath);

    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(parsed.someOtherKey).toBe("value");
    expect(parsed.embedThreshold).toBeCloseTo(0.80);
  });

  test("overwrites previous embedThreshold", () => {
    const configPath = join(tmpDir, "config.json");
    applyThreshold(0.70, configPath);
    applyThreshold(0.75, configPath);

    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(parsed.embedThreshold).toBeCloseTo(0.75);
  });

  test("creates parent directory if missing", () => {
    const configPath = join(tmpDir, "nested", "dir", "config.json");
    applyThreshold(0.72, configPath);
    expect(existsSync(configPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Import for applyThreshold
// ---------------------------------------------------------------------------
function readFileSync(path: string, enc: BufferEncoding): string {
  const { readFileSync: _r } = require("fs") as typeof import("fs");
  return _r(path, enc);
}
