/**
 * Tests for the grep calibration harness.
 *
 * Covers:
 *   - getCalibrationMultiplier(): absent file → 4, present file → meanRatio,
 *     malformed file → 4
 *   - percentile / mean helpers
 *   - renderReport output shape
 *   - runCalibration: writes calibration.json with correct shape (synthetic
 *     fixture, no real genome required)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  mean,
  percentile,
  renderReport,
  runCalibration,
  syntheticSampleNoGenome,
  syntheticWorkload,
} from "../scripts/calibrate-grep";
import {
  clearCalibrationCache,
  DEFAULT_MULTIPLIER,
  getCalibrationMultiplier,
  type CalibrationFile,
  type CalibrationSample,
} from "../scripts/read-calibration";
import { captureGrepWorkload } from "../scripts/capture-grep-workload";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome: string;

function calibPath(): string {
  return join(tmpHome, "calibration.json");
}

function writeCalib(data: unknown): void {
  writeFileSync(calibPath(), JSON.stringify(data));
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ashlr-calib-test-"));
  // Always clear in-process cache before each test so file reads are fresh.
  clearCalibrationCache();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  clearCalibrationCache();
});

// ---------------------------------------------------------------------------
// getCalibrationMultiplier
// ---------------------------------------------------------------------------

describe("getCalibrationMultiplier", () => {
  test("absent file → DEFAULT_MULTIPLIER (4)", () => {
    const result = getCalibrationMultiplier(calibPath());
    expect(result).toBe(DEFAULT_MULTIPLIER);
    expect(result).toBe(4);
  });

  test("valid file → returns meanRatio", () => {
    writeCalib({
      updatedAt: new Date().toISOString(),
      samples: [],
      meanRatio: 6.7,
      p50: 5.5,
      p90: 9.2,
    } satisfies CalibrationFile);
    const result = getCalibrationMultiplier(calibPath());
    expect(result).toBeCloseTo(6.7);
  });

  test("meanRatio of 1.0 is valid and returned", () => {
    writeCalib({ updatedAt: "2026-01-01T00:00:00Z", samples: [], meanRatio: 1.0, p50: 1.0, p90: 1.0 });
    expect(getCalibrationMultiplier(calibPath())).toBe(1.0);
  });

  test("malformed JSON → DEFAULT_MULTIPLIER", () => {
    writeFileSync(calibPath(), "{ not valid json }}}");
    expect(getCalibrationMultiplier(calibPath())).toBe(DEFAULT_MULTIPLIER);
  });

  test("missing meanRatio field → DEFAULT_MULTIPLIER", () => {
    writeCalib({ updatedAt: "2026-01-01T00:00:00Z", samples: [] });
    expect(getCalibrationMultiplier(calibPath())).toBe(DEFAULT_MULTIPLIER);
  });

  test("meanRatio: null → DEFAULT_MULTIPLIER", () => {
    writeCalib({ updatedAt: "2026-01-01T00:00:00Z", samples: [], meanRatio: null });
    expect(getCalibrationMultiplier(calibPath())).toBe(DEFAULT_MULTIPLIER);
  });

  test("meanRatio: 0 → DEFAULT_MULTIPLIER (non-positive rejected)", () => {
    writeCalib({ updatedAt: "2026-01-01T00:00:00Z", samples: [], meanRatio: 0, p50: 0, p90: 0 });
    expect(getCalibrationMultiplier(calibPath())).toBe(DEFAULT_MULTIPLIER);
  });

  test("meanRatio: -1 → DEFAULT_MULTIPLIER", () => {
    writeCalib({ updatedAt: "2026-01-01T00:00:00Z", samples: [], meanRatio: -1, p50: -1, p90: -1 });
    expect(getCalibrationMultiplier(calibPath())).toBe(DEFAULT_MULTIPLIER);
  });

  test("meanRatio: NaN → DEFAULT_MULTIPLIER", () => {
    // JSON.stringify turns NaN → null, so we write raw JSON
    writeFileSync(calibPath(), '{"updatedAt":"2026-01-01","samples":[],"meanRatio":null,"p50":null,"p90":null}');
    expect(getCalibrationMultiplier(calibPath())).toBe(DEFAULT_MULTIPLIER);
  });

  test("empty file → DEFAULT_MULTIPLIER", () => {
    writeFileSync(calibPath(), "");
    expect(getCalibrationMultiplier(calibPath())).toBe(DEFAULT_MULTIPLIER);
  });
});

// ---------------------------------------------------------------------------
// percentile + mean
// ---------------------------------------------------------------------------

describe("percentile", () => {
  test("empty array → 0", () => {
    expect(percentile([], 50)).toBe(0);
  });

  test("single element", () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 90)).toBe(7);
  });

  test("p50 of sorted array", () => {
    // floor(50/100 * 10) = index 5 → value 6 (0-based floor implementation)
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(6);
  });

  test("p90 of sorted array", () => {
    // floor(90/100 * 10) = index 9 → value 10
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 90)).toBe(10);
  });

  test("p100 is the last element", () => {
    const sorted = [1, 2, 3];
    expect(percentile(sorted, 100)).toBe(3);
  });
});

describe("mean", () => {
  test("empty → 0", () => {
    expect(mean([])).toBe(0);
  });

  test("single value", () => {
    expect(mean([42])).toBe(42);
  });

  test("multiple values", () => {
    expect(mean([2, 4, 6])).toBeCloseTo(4);
  });
});

// ---------------------------------------------------------------------------
// renderReport
// ---------------------------------------------------------------------------

describe("renderReport", () => {
  test("empty samples → fallback message", () => {
    const out = renderReport([], 4, 4, 4, "/tmp/calibration.json");
    expect(out).toContain("No samples");
  });

  test("with samples → shows header, table, aggregates, output path", () => {
    const samples = [
      { cwd: "/a", pattern: "foo", rawBytes: 1000, compressedBytes: 200, ratio: 5.0 },
      { cwd: "/b", pattern: "bar", rawBytes: 2000, compressedBytes: 500, ratio: 4.0 },
    ];
    const out = renderReport(samples, 4.5, 4.5, 5.0, "/tmp/calibration.json");
    expect(out).toContain("ashlr grep calibration report");
    expect(out).toContain("foo");
    expect(out).toContain("bar");
    expect(out).toContain("4.50×");   // mean
    expect(out).toContain("5.00×");   // p90
    expect(out).toContain("/tmp/calibration.json");
    expect(out).toContain("samples        2");
  });
});

// ---------------------------------------------------------------------------
// syntheticWorkload
// ---------------------------------------------------------------------------

describe("syntheticWorkload", () => {
  test("returns at least 5 workloads", () => {
    const wl = syntheticWorkload();
    expect(wl.length).toBeGreaterThanOrEqual(5);
  });

  test("each workload has cwd and pattern strings", () => {
    for (const w of syntheticWorkload()) {
      expect(typeof w.cwd).toBe("string");
      expect(w.cwd.length).toBeGreaterThan(0);
      expect(typeof w.pattern).toBe("string");
      expect(w.pattern.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// syntheticSampleNoGenome
// ---------------------------------------------------------------------------

describe("syntheticSampleNoGenome", () => {
  test("ratio is rawBytes / compressedBytes", () => {
    const s = syntheticSampleNoGenome({ cwd: "/x", pattern: "p" }, 4000);
    expect(s.rawBytes).toBe(4000);
    expect(s.compressedBytes).toBeGreaterThan(0);
    expect(s.ratio).toBeCloseTo(s.rawBytes / s.compressedBytes);
  });

  test("very small rawBytes → compressedBytes is at least 1", () => {
    const s = syntheticSampleNoGenome({ cwd: "/x", pattern: "p" }, 1);
    expect(s.compressedBytes).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// runCalibration integration (synthetic, no genome)
// ---------------------------------------------------------------------------

describe("runCalibration (synthetic fixture)", () => {
  test("writes calibration.json with correct shape", async () => {
    const outPath = join(tmpHome, "calibration.json");
    const result = await runCalibration({ outPath });

    expect(typeof result.updatedAt).toBe("string");
    expect(Array.isArray(result.samples)).toBe(true);
    expect(typeof result.meanRatio).toBe("number");
    expect(typeof result.p50).toBe("number");
    expect(typeof result.p90).toBe("number");
    // meanRatio must be positive (either empirical or fallback 4 when rg absent)
    expect(result.meanRatio).toBeGreaterThan(0);
  }, 30_000);

  test("written file is readable by getCalibrationMultiplier", async () => {
    const outPath = join(tmpHome, "calibration.json");
    const result = await runCalibration({ outPath });

    const { existsSync } = await import("fs");
    expect(existsSync(outPath)).toBe(true);

    clearCalibrationCache();
    const multiplier = getCalibrationMultiplier(outPath);
    expect(multiplier).toBeCloseTo(result.meanRatio);
  }, 30_000);

  test("custom outPath is respected — does not write to default location", async () => {
    const outPath = join(tmpHome, "custom-calib.json");
    await runCalibration({ outPath });

    const { existsSync } = await import("fs");
    expect(existsSync(outPath)).toBe(true);
    // The default calibration.json should not have been written
    expect(existsSync(join(tmpHome, "calibration.json"))).toBe(false);
  }, 30_000);

  test("samples array (when rg available) has required fields including quality", async () => {
    const outPath = join(tmpHome, "calibration.json");
    const result = await runCalibration({ outPath });

    // rg may not be available in the test sandbox — skip field checks when
    // no samples were collected (that case is covered by the shape test above).
    if (result.samples.length === 0) return;

    for (const s of result.samples) {
      expect(typeof s.cwd).toBe("string");
      expect(typeof s.pattern).toBe("string");
      expect(typeof s.rawBytes).toBe("number");
      expect(typeof s.compressedBytes).toBe("number");
      expect(typeof s.ratio).toBe("number");
      expect(s.rawBytes).toBeGreaterThan(0);
      expect(s.compressedBytes).toBeGreaterThan(0);
      expect(s.ratio).toBeGreaterThan(0);
      // quality must be present and one of the two allowed values.
      expect(["measured", "synthetic"]).toContain(s.quality);
    }
  }, 30_000);

  test("CalibrationFile has split aggregate fields when samples exist", async () => {
    const outPath = join(tmpHome, "calibration.json");
    const result = await runCalibration({ outPath });

    if (result.samples.length === 0) return;

    // measuredCount should always be present.
    expect(typeof result.measuredCount).toBe("number");
    expect(result.measuredCount).toBeGreaterThanOrEqual(0);

    const measuredSamples = result.samples.filter((s) => s.quality === "measured");
    const syntheticSamples = result.samples.filter((s) => s.quality === "synthetic");

    expect(result.measuredCount).toBe(measuredSamples.length);

    if (measuredSamples.length > 0) {
      expect(typeof result.measuredMean).toBe("number");
      expect(result.measuredMean).toBeGreaterThan(0);
    }
    if (syntheticSamples.length > 0) {
      expect(typeof result.syntheticMean).toBe("number");
      expect(result.syntheticMean).toBeGreaterThan(0);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// syntheticSampleNoGenome quality flag
// ---------------------------------------------------------------------------

describe("syntheticSampleNoGenome quality", () => {
  test("quality is 'synthetic'", () => {
    const s = syntheticSampleNoGenome({ cwd: "/x", pattern: "p" }, 4000);
    expect(s.quality).toBe("synthetic");
  });
});

// ---------------------------------------------------------------------------
// getCalibrationMultiplier prefers measuredMean
// ---------------------------------------------------------------------------

describe("getCalibrationMultiplier — measuredMean preference", () => {
  test("returns measuredMean when present and measuredCount > 0", () => {
    writeCalib({
      updatedAt: new Date().toISOString(),
      samples: [],
      meanRatio: 4.0,
      p50: 4.0,
      p90: 4.0,
      measuredMean: 12.5,
      syntheticMean: 4.0,
      measuredCount: 3,
    } satisfies CalibrationFile);
    expect(getCalibrationMultiplier(calibPath())).toBeCloseTo(12.5);
  });

  test("falls back to meanRatio when measuredCount is 0", () => {
    writeCalib({
      updatedAt: new Date().toISOString(),
      samples: [],
      meanRatio: 7.3,
      p50: 7.3,
      p90: 7.3,
      measuredMean: 0,
      syntheticMean: 4.0,
      measuredCount: 0,
    } satisfies CalibrationFile);
    expect(getCalibrationMultiplier(calibPath())).toBeCloseTo(7.3);
  });

  test("falls back to meanRatio when measuredMean is absent", () => {
    writeCalib({
      updatedAt: new Date().toISOString(),
      samples: [],
      meanRatio: 5.5,
      p50: 5.5,
      p90: 5.5,
    } satisfies CalibrationFile);
    expect(getCalibrationMultiplier(calibPath())).toBeCloseTo(5.5);
  });
});

// ---------------------------------------------------------------------------
// renderReport quality column
// ---------------------------------------------------------------------------

describe("renderReport quality column", () => {
  test("shows 'measured' in quality column when quality=measured", () => {
    const samples: CalibrationSample[] = [
      {
        cwd: "/a",
        pattern: "foo",
        rawBytes: 10000,
        compressedBytes: 200,
        ratio: 50,
        quality: "measured",
      },
    ];
    const out = renderReport(samples, 50, 50, 50, "/tmp/cal.json", 50, undefined, 1);
    expect(out).toContain("measured");
    expect(out).not.toContain("synthetic");
  });

  test("shows 'synthetic' and WARNING when all samples synthetic", () => {
    const samples: CalibrationSample[] = [
      {
        cwd: "/a",
        pattern: "bar",
        rawBytes: 4000,
        compressedBytes: 1000,
        ratio: 4,
        quality: "synthetic",
      },
      {
        cwd: "/b",
        pattern: "baz",
        rawBytes: 8000,
        compressedBytes: 2000,
        ratio: 4,
        quality: "synthetic",
      },
    ];
    const out = renderReport(samples, 4, 4, 4, "/tmp/cal.json", undefined, 4, 0);
    expect(out).toContain("synthetic");
    expect(out).toContain("WARNING");
  });

  test("measured count shown correctly when mixed", () => {
    const samples: CalibrationSample[] = [
      { cwd: "/a", pattern: "p1", rawBytes: 1000, compressedBytes: 100, ratio: 10, quality: "measured" },
      { cwd: "/b", pattern: "p2", rawBytes: 4000, compressedBytes: 1000, ratio: 4, quality: "synthetic" },
    ];
    const out = renderReport(samples, 7, 7, 10, "/tmp/cal.json", 10, 4, 1);
    expect(out).toContain("measured       1");
    expect(out).toContain("synthetic      1");
    // 1/2 = 50% synthetic — exactly at threshold, should not trigger WARNING.
    expect(out).not.toContain("WARNING");
  });
});

// ---------------------------------------------------------------------------
// captureGrepWorkload
// ---------------------------------------------------------------------------

describe("captureGrepWorkload", () => {
  test("handles missing session log gracefully", async () => {
    const outPath = join(tmpHome, "workload.jsonl");
    const logPath = join(tmpHome, "nonexistent-session-log.jsonl");

    const result = await captureGrepWorkload({ logPath, outPath, n: 100 });

    expect(result.cwds).toHaveLength(0);
    expect(result.entries).toHaveLength(0);
    // Should not create the output file when no data.
    const { existsSync } = await import("fs");
    expect(existsSync(outPath)).toBe(false);
  });

  test("extracts grep cwds from session log events", async () => {
    const { mkdirSync, writeFileSync } = await import("fs");
    const logPath = join(tmpHome, "session-log.jsonl");
    const outPath = join(tmpHome, "workload.jsonl");

    // Write mock session log with grep events.
    const events = [
      {
        ts: "2026-05-01T00:00:00Z",
        event: "genome_route_taken",
        tool: "ashlr__grep",
        cwd: tmpHome, // tmpHome exists on disk
        session: "sess-1",
      },
      {
        ts: "2026-05-01T00:01:00Z",
        event: "tool_fallback",
        tool: "ashlr__grep",
        cwd: tmpHome,
        session: "sess-1",
      },
      {
        ts: "2026-05-01T00:02:00Z",
        event: "tool_call",
        tool: "ashlr__read", // different tool — should be ignored
        cwd: tmpHome,
        session: "sess-1",
      },
    ];
    writeFileSync(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    const result = await captureGrepWorkload({ logPath, outPath, n: 100 });

    // tmpHome appears in two grep events → one unique cwd.
    expect(result.cwds).toHaveLength(1);
    expect(result.cwds[0]).toBe(tmpHome);

    // entries = cwds × representative patterns
    expect(result.entries.length).toBeGreaterThan(0);
    for (const e of result.entries) {
      expect(e.cwd).toBe(tmpHome);
      expect(typeof e.pattern).toBe("string");
      expect(e.pattern.length).toBeGreaterThan(0);
    }
  });

  test("output file is valid JSONL readable by calibrate-grep workload parser", async () => {
    const { writeFileSync, readFileSync, existsSync } = await import("fs");
    const logPath = join(tmpHome, "session-log.jsonl");
    const outPath = join(tmpHome, "workload.jsonl");

    const event = {
      ts: "2026-05-01T00:00:00Z",
      event: "genome_search_miss",
      tool: "ashlr__grep",
      cwd: tmpHome,
      session: "sess-test",
    };
    writeFileSync(logPath, JSON.stringify(event) + "\n", "utf-8");

    const result = await captureGrepWorkload({ logPath, outPath, n: 50 });
    expect(result.entries.length).toBeGreaterThan(0);

    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(result.entries.length);

    for (const line of lines) {
      const parsed = JSON.parse(line) as { cwd: string; pattern: string };
      expect(typeof parsed.cwd).toBe("string");
      expect(typeof parsed.pattern).toBe("string");
    }
  });

  test("respects --n flag to limit events scanned", async () => {
    const { writeFileSync } = await import("fs");
    const logPath = join(tmpHome, "session-log.jsonl");
    const outPath = join(tmpHome, "workload.jsonl");

    // Write 10 events with two different cwds.
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({
        ts: `2026-05-01T00:0${i}:00Z`,
        event: "genome_route_taken",
        tool: "ashlr__grep",
        cwd: tmpHome,
      }));
    }
    // These 5 events have a non-existent cwd and come first — with n=5 they'll be excluded.
    const nonExistentCwd = join(tmpHome, "does-not-exist-12345");
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({
        ts: `2026-04-30T00:0${i}:00Z`,
        event: "genome_route_taken",
        tool: "ashlr__grep",
        cwd: nonExistentCwd,
      }));
    }
    writeFileSync(logPath, lines.reverse().join("\n") + "\n", "utf-8");

    // Scan only last 5 lines → only tmpHome events.
    const result = await captureGrepWorkload({ logPath, outPath, n: 5 });
    expect(result.cwds).toContain(tmpHome);
    // nonExistentCwd should be filtered (doesn't exist on disk).
    expect(result.cwds).not.toContain(nonExistentCwd);
  });
});
