/**
 * hook-timings-report.test.ts
 *
 * Tests for scripts/hook-timings-report.ts:
 *   - empty / missing log
 *   - single record per hook
 *   - percentile correctness on a seeded dataset
 *   - --hours window filter
 *   - outcome-class breakdown (error%, block%)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  computeAggregates,
  readHookTimings,
  renderReport,
  type HookTimingRecord,
} from "../scripts/hook-timings-report";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dir: string;
let timingsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ashlr-hook-timings-report-"));
  timingsPath = join(dir, "hook-timings.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function makeRecord(
  hook: string,
  durationMs: number,
  outcome: HookTimingRecord["outcome"] = "ok",
  minsAgo = 0,
): HookTimingRecord {
  const ts = new Date(Date.now() - minsAgo * 60_000).toISOString();
  return { ts, hook, tool: null, durationMs, outcome };
}

async function writeTimings(records: HookTimingRecord[]): Promise<void> {
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(timingsPath, lines, "utf-8");
}

// ---------------------------------------------------------------------------
// readHookTimings
// ---------------------------------------------------------------------------

describe("readHookTimings", () => {
  test("returns [] for missing file", () => {
    const result = readHookTimings(join(dir, "nonexistent.jsonl"));
    expect(result).toEqual([]);
  });

  test("returns [] for empty file", async () => {
    await writeFile(timingsPath, "", "utf-8");
    expect(readHookTimings(timingsPath)).toEqual([]);
  });

  test("skips malformed lines without throwing", async () => {
    await writeFile(
      timingsPath,
      [
        "not json at all",
        JSON.stringify(makeRecord("pretooluse-read", 10)),
        "{broken",
        JSON.stringify(makeRecord("pretooluse-grep", 20)),
        '{"ts":"2026-01-01T00:00:00Z","missing_hook":true}',
      ].join("\n") + "\n",
      "utf-8",
    );
    const records = readHookTimings(timingsPath);
    expect(records.length).toBe(2);
    expect(records[0]!.hook).toBe("pretooluse-read");
    expect(records[1]!.hook).toBe("pretooluse-grep");
  });

  test("parses all fields correctly", async () => {
    const rec = makeRecord("policy-enforce", 42, "block");
    await writeTimings([rec]);
    const records = readHookTimings(timingsPath);
    expect(records.length).toBe(1);
    expect(records[0]!.hook).toBe("policy-enforce");
    expect(records[0]!.durationMs).toBe(42);
    expect(records[0]!.outcome).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// computeAggregates
// ---------------------------------------------------------------------------

describe("computeAggregates — empty input", () => {
  test("returns [] for empty records", () => {
    expect(computeAggregates([])).toEqual([]);
  });

  test("returns [] when all records are outside window", () => {
    const old = makeRecord("hook-a", 10, "ok", 48 * 60); // 48h ago
    expect(computeAggregates([old], 24)).toEqual([]);
  });
});

describe("computeAggregates — single record per hook", () => {
  test("single record gives p50 = p95 = max = that value", () => {
    const records = [makeRecord("pretooluse-read", 55)];
    const agg = computeAggregates(records, 24);
    expect(agg.length).toBe(1);
    expect(agg[0]!.hook).toBe("pretooluse-read");
    expect(agg[0]!.calls).toBe(1);
    expect(agg[0]!.p50).toBe(55);
    expect(agg[0]!.p95).toBe(55);
    expect(agg[0]!.max).toBe(55);
    expect(agg[0]!.errorPct).toBe(0);
    expect(agg[0]!.blockPct).toBe(0);
  });
});

describe("computeAggregates — percentile correctness", () => {
  // Build 100 records with durations 1..100ms for "hook-a"
  const seeded: HookTimingRecord[] = Array.from({ length: 100 }, (_, i) =>
    makeRecord("hook-a", i + 1),
  );

  test("p50 of 1..100 is 50 or 51", () => {
    const [agg] = computeAggregates(seeded, 24);
    expect(agg!.p50).toBeGreaterThanOrEqual(50);
    expect(agg!.p50).toBeLessThanOrEqual(51);
  });

  test("p95 of 1..100 is 95 or 96", () => {
    const [agg] = computeAggregates(seeded, 24);
    expect(agg!.p95).toBeGreaterThanOrEqual(95);
    expect(agg!.p95).toBeLessThanOrEqual(96);
  });

  test("max of 1..100 is 100", () => {
    const [agg] = computeAggregates(seeded, 24);
    expect(agg!.max).toBe(100);
  });
});

describe("computeAggregates — --hours window filter", () => {
  test("records older than window are excluded", () => {
    const fresh = makeRecord("hook-b", 10, "ok", 10);   // 10 min ago
    const stale = makeRecord("hook-b", 10, "ok", 25 * 60); // 25h ago
    const agg = computeAggregates([fresh, stale], 24);
    expect(agg.length).toBe(1);
    expect(agg[0]!.calls).toBe(1);
  });

  test("Infinity window includes all records", () => {
    const stale = makeRecord("hook-c", 10, "ok", 365 * 24 * 60); // 1 year ago
    const agg = computeAggregates([stale], Infinity);
    expect(agg.length).toBe(1);
    expect(agg[0]!.calls).toBe(1);
  });
});

describe("computeAggregates — outcome breakdown", () => {
  test("errorPct and blockPct are computed correctly", () => {
    const records: HookTimingRecord[] = [
      makeRecord("policy-enforce", 20, "ok"),
      makeRecord("policy-enforce", 25, "ok"),
      makeRecord("policy-enforce", 30, "error"),
      makeRecord("policy-enforce", 15, "block"),
      makeRecord("policy-enforce", 18, "block"),
    ];
    const [agg] = computeAggregates(records, 24);
    expect(agg!.calls).toBe(5);
    expect(agg!.errorPct).toBeCloseTo(20, 1); // 1/5
    expect(agg!.blockPct).toBeCloseTo(40, 1); // 2/5
  });

  test("bypass outcome counts as neither error nor block", () => {
    const records: HookTimingRecord[] = [
      makeRecord("pretooluse-grep", 8, "bypass"),
      makeRecord("pretooluse-grep", 9, "bypass"),
    ];
    const [agg] = computeAggregates(records, 24);
    expect(agg!.errorPct).toBe(0);
    expect(agg!.blockPct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// renderReport
// ---------------------------------------------------------------------------

describe("renderReport", () => {
  test("empty state message when totalRecords is 0", () => {
    const out = renderReport([], 24, 0);
    expect(out).toContain("no records yet");
    expect(out).toContain("enable hooks");
  });

  test("header shows window and record count", () => {
    const agg = computeAggregates([makeRecord("h", 10)], 24);
    const out = renderReport(agg, 24, 1);
    expect(out).toContain("last 24h");
    expect(out).toContain("1 records");
  });

  test("flag emitted when p95 > 100ms", () => {
    // 4 records at 10ms + 1 at 200ms → p95 index = 0.95*4 = 3.8 → rounds to 200ms
    const records = [
      makeRecord("policy-enforce", 10),
      makeRecord("policy-enforce", 10),
      makeRecord("policy-enforce", 10),
      makeRecord("policy-enforce", 10),
      makeRecord("policy-enforce", 200),
    ];
    const agg = computeAggregates(records, 24);
    const out = renderReport(agg, 24, records.length);
    expect(out).toContain("p95 > 100ms");
  });

  test("flag emitted when max >= 1000ms", () => {
    const records = [
      makeRecord("post-tool-use-genome", 50),
      makeRecord("post-tool-use-genome", 2300),
    ];
    const agg = computeAggregates(records, 24);
    const out = renderReport(agg, 24, 2);
    expect(out).toContain("investigate slow path");
    expect(out).toContain("2.3s");
  });

  test("output fits within 80 columns per line", () => {
    const records = [
      makeRecord("pretooluse-read", 12),
      makeRecord("pretooluse-grep", 8),
      makeRecord("policy-enforce", 22),
    ];
    const agg = computeAggregates(records, 24);
    const out = renderReport(agg, 24, records.length);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  test("no ANSI escape sequences in output", () => {
    const agg = computeAggregates([makeRecord("h", 10)], 24);
    const out = renderReport(agg, 24, 1);
    expect(out).not.toMatch(/\x1b\[/);
  });
});
