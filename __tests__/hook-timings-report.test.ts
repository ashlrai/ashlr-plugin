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
import { mkdirSync, renameSync, writeFileSync } from "fs";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  computeAggregates,
  computeTrends,
  readHookTimings,
  readHookTimingsDetailed,
  renderCompact,
  renderReport,
  type HookTimingRecord,
} from "../scripts/hook-timings-report";
import { HOOK_TIMING_SOURCE_MAX_BYTES } from "../scripts/hook-timing-reader";

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

  test("reads retained rows before active rows and supports a legacy single file", async () => {
    const retained = makeRecord("retained", 10);
    const active = makeRecord("active", 20);
    await writeFile(`${timingsPath}.1`, JSON.stringify(retained) + "\n");
    await writeFile(timingsPath, JSON.stringify(active));

    expect(readHookTimings(timingsPath).map((row) => row.hook)).toEqual(["retained", "active"]);
    await rm(`${timingsPath}.1`);
    expect(readHookTimings(timingsPath).map((row) => row.hook)).toEqual(["active"]);
  });

  test("reports partial coverage when dropped history intersects the requested window", async () => {
    const sinceMs = Date.now() - 60_000;
    await writeTimings([makeRecord("active", 10)]);
    await writeFile(`${timingsPath}.meta.json`, JSON.stringify({
      schemaVersion: 1,
      droppedThrough: new Date(sinceMs + 1_000).toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const detailed = readHookTimingsDetailed(timingsPath, sinceMs);
    expect(detailed.coverage).toBe("partial");
    expect(detailed.quality.droppedThrough).not.toBeNull();
  });

  test("filters old unordered rows during retention while scanning and counting all rows", async () => {
    const sinceMs = Date.now() - 60_000;
    const recentRetained = { ...makeRecord("recent-retained", 10), ts: new Date(sinceMs + 1_000).toISOString() };
    const oldRetained = { ...makeRecord("old-retained", 20), ts: new Date(sinceMs - 1_000).toISOString() };
    const recentActive = { ...makeRecord("recent-active", 30), ts: new Date(sinceMs + 2_000).toISOString() };
    const oldActive = { ...makeRecord("old-active", 40), ts: new Date(sinceMs - 2_000).toISOString() };
    const weakRecent = { ts: new Date(sinceMs + 3_000).toISOString(), outcome: "block" };

    // Recent rows deliberately follow old rows to prove the scanner does not stop early.
    await writeFile(`${timingsPath}.1`, [oldRetained, recentRetained]
      .map((row) => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(timingsPath, [oldActive, recentActive, weakRecent]
      .map((row) => JSON.stringify(row)).join("\n") + "\n");

    const detailed = readHookTimingsDetailed(timingsPath, sinceMs);
    expect(detailed.records.map((row) => row.hook)).toEqual([
      "recent-retained",
      "recent-active",
    ]);
    expect(detailed.rows).toEqual([recentRetained, recentActive, weakRecent]);
    expect(detailed.sourceQuality.map((source) => source.parsedRows)).toEqual([2, 3]);
    expect(detailed.sourceQuality.map((source) => source.retainedRows)).toEqual([1, 2]);
    expect(detailed.sourceQuality[1]!.malformedRows).toBe(1);
  });

  test("reports partial coverage for an all-history read after known retention loss", async () => {
    await writeTimings([makeRecord("active", 10)]);
    await writeFile(`${timingsPath}.meta.json`, JSON.stringify({
      schemaVersion: 1,
      droppedThrough: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    expect(readHookTimingsDetailed(timingsPath).coverage).toBe("partial");
  });

  test("treats present metadata with an unknown droppedThrough as partial", async () => {
    await writeTimings([makeRecord("active", 10)]);
    await writeFile(`${timingsPath}.meta.json`, JSON.stringify({
      schemaVersion: 1,
      droppedThrough: null,
      updatedAt: new Date().toISOString(),
    }));

    const detailed = readHookTimingsDetailed(timingsPath, Date.now() - 60_000);
    expect(detailed.quality.metadataPresent).toBe(true);
    expect(detailed.quality.droppedThrough).toBeNull();
    expect(detailed.coverage).toBe("partial");
  });

  test("reports partial coverage when a syntactically valid row fails the timing schema", async () => {
    await writeFile(timingsPath, [
      JSON.stringify(makeRecord("valid", 10)),
      JSON.stringify({ ts: new Date().toISOString(), outcome: "block" }),
      "",
    ].join("\n"));

    const detailed = readHookTimingsDetailed(timingsPath);
    expect(detailed.records.map((row) => row.hook)).toEqual(["valid"]);
    expect(detailed.sourceQuality[1]!.malformedRows).toBe(1);
    expect(detailed.coverage).toBe("partial");
  });

  test("skips malformed and oversized rows with bounded source evidence", async () => {
    const valid = makeRecord("valid", 10);
    await writeFile(timingsPath, [
      JSON.stringify(valid),
      "{broken",
      JSON.stringify({ ...valid, hook: "x".repeat(4_000) }),
      "",
    ].join("\n"));

    const detailed = readHookTimingsDetailed({ path: timingsPath, maxRowBytes: 1024, chunkBytes: 1024 });
    expect(detailed.records.map((row) => row.hook)).toEqual(["valid"]);
    expect(detailed.sourceQuality[1]!.malformedRows).toBe(1);
    expect(detailed.sourceQuality[1]!.oversizedRows).toBe(1);
    expect(detailed.coverage).toBe("partial");
  });

  test("marks a malformed unterminated tail as truncated and excludes it", async () => {
    await writeFile(timingsPath, JSON.stringify(makeRecord("good", 10)) + "\n{\"ts\":");
    const detailed = readHookTimingsDetailed(timingsPath);
    expect(detailed.records.map((row) => row.hook)).toEqual(["good"]);
    expect(detailed.sourceQuality[1]!.truncatedTail).toBe(true);
    expect(detailed.coverage).toBe("partial");
  });

  test("retries once when rotation changes the two-file snapshot", async () => {
    await writeTimings([makeRecord("before-rotation", 10)]);
    let rotated = false;
    const detailed = readHookTimingsDetailed({
      path: timingsPath,
      _beforeVerify: (attempt) => {
        if (attempt !== 0 || rotated) return;
        rotated = true;
        // Synchronous filesystem calls are intentional inside the synchronous reader seam.
        writeFileSync(`${timingsPath}.next`, JSON.stringify(makeRecord("after-rotation", 20)) + "\n");
        renameSync(timingsPath, `${timingsPath}.1`);
        renameSync(`${timingsPath}.next`, timingsPath);
      },
    });

    expect(detailed.quality.retries).toBe(1);
    expect(detailed.records.map((row) => row.hook)).toEqual([
      "before-rotation",
      "after-rotation",
    ]);
    expect(detailed.coverage).toBe("complete");
  });

  test("never accepts a between-renames snapshot while the writer lock exists", async () => {
    await writeTimings([makeRecord("pre-transaction", 10)]);
    let moved = false;
    const detailed = readHookTimingsDetailed({
      path: timingsPath,
      _beforeVerify: (attempt) => {
        if (attempt !== 0 || moved) return;
        moved = true;
        mkdirSync(`${timingsPath}.lock`);
        renameSync(timingsPath, `${timingsPath}.1`);
      },
    });

    expect(detailed.records).toEqual([]);
    expect(detailed.rows).toEqual([]);
    expect(detailed.quality.writerLockObserved).toBe(true);
    expect(detailed.sourceQuality.every((source) => source.raced)).toBe(true);
    expect(detailed.coverage).toBe("partial");
  });

  test("bounds foreign sources to the newest 16 MiB on a line boundary", async () => {
    const sinceMs = Date.now() - 60_000;
    const oldRow = JSON.stringify({
      ...makeRecord("old", 10),
      ts: new Date(sinceMs - 1_000).toISOString(),
      padding: "x".repeat(900),
    }) + "\n";
    const recentRow = JSON.stringify({
      ...makeRecord("recent", 20),
      ts: new Date(sinceMs + 1_000).toISOString(),
    }) + "\n";
    const repeats = Math.ceil((HOOK_TIMING_SOURCE_MAX_BYTES + 4096) / Buffer.byteLength(oldRow));
    await writeFile(timingsPath, oldRow.repeat(repeats) + recentRow);

    const detailed = readHookTimingsDetailed(timingsPath, sinceMs);
    const active = detailed.sourceQuality[1]!;
    expect(active.bytesRead).toBe(HOOK_TIMING_SOURCE_MAX_BYTES);
    expect(active.truncatedPrefix).toBe(true);
    expect(active.parsedRows).toBeGreaterThan(0);
    expect(detailed.records.map((row) => row.hook)).toEqual(["recent"]);
    expect(detailed.coverage).toBe("partial");
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

  test("trend indicator ↓ appears for improved hook", () => {
    const agg = computeAggregates([makeRecord("h", 10)], 24);
    const trends = [{ hook: "h", current: { mean: 10, p50: 10, p95: 10 }, compare: { mean: 50, p50: 50, p95: 50 }, deltaMs: -40, deltaPct: -80, trend: "improved" as const }];
    const out = renderReport(agg, 24, 1, trends);
    expect(out).toContain("↓");
  });

  test("trend indicator ↑ appears for regressed hook", () => {
    const agg = computeAggregates([makeRecord("h", 100)], 24);
    const trends = [{ hook: "h", current: { mean: 100, p50: 100, p95: 100 }, compare: { mean: 50, p50: 50, p95: 50 }, deltaMs: 50, deltaPct: 100, trend: "regressed" as const }];
    const out = renderReport(agg, 24, 1, trends);
    expect(out).toContain("↑");
  });

  test("slow-hook flag: exactly 200ms → no ⚠ flag", () => {
    const records = Array.from({ length: 20 }, () => makeRecord("h", 200));
    const agg = computeAggregates(records, 24);
    const out = renderReport(agg, 24, records.length);
    expect(out).not.toContain("⚠");
    expect(out).not.toContain("exceeds 200ms threshold");
  });

  test("slow-hook flag: 201ms → ⚠ flag emitted", () => {
    const records = Array.from({ length: 20 }, () => makeRecord("slow-hook", 201));
    const agg = computeAggregates(records, 24);
    const out = renderReport(agg, 24, records.length);
    expect(out).toContain("⚠");
    expect(out).toContain("slow-hook");
    expect(out).toContain("exceeds 200ms threshold");
  });

  test("slow-hook flag: multiple slow hooks → multiple flags", () => {
    const records = [
      ...Array.from({ length: 20 }, () => makeRecord("hook-alpha", 250)),
      ...Array.from({ length: 20 }, () => makeRecord("hook-beta", 300)),
    ];
    const agg = computeAggregates(records, 24);
    const out = renderReport(agg, 24, records.length);
    expect(out).toContain("hook-alpha");
    expect(out).toContain("hook-beta");
    const flagCount = (out.match(/⚠/g) ?? []).length;
    expect(flagCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeTrends
// ---------------------------------------------------------------------------

describe("computeTrends", () => {
  test("improved: p95 dropped ≥20%", () => {
    const now = Date.now();
    // Current window: 10ms each (last 1h)
    const current = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(now - i * 60_000).toISOString(),
      hook: "h", tool: null, durationMs: 10, outcome: "ok" as const,
    }));
    // Compare window: 50ms each (1–2h ago)
    const compare = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(now - 3_600_000 - i * 60_000).toISOString(),
      hook: "h", tool: null, durationMs: 50, outcome: "ok" as const,
    }));
    const trends = computeTrends([...current, ...compare], { windowHours: 1, compareHours: 1 });
    expect(trends.length).toBe(1);
    expect(trends[0]!.trend).toBe("improved");
    expect(trends[0]!.deltaPct).toBeLessThan(-20);
  });

  test("regressed: p95 grew ≥20%", () => {
    const now = Date.now();
    const current = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(now - i * 60_000).toISOString(),
      hook: "h", tool: null, durationMs: 100, outcome: "ok" as const,
    }));
    const compare = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(now - 3_600_000 - i * 60_000).toISOString(),
      hook: "h", tool: null, durationMs: 50, outcome: "ok" as const,
    }));
    const trends = computeTrends([...current, ...compare], { windowHours: 1, compareHours: 1 });
    expect(trends.length).toBe(1);
    expect(trends[0]!.trend).toBe("regressed");
    expect(trends[0]!.deltaPct).toBeGreaterThan(20);
  });

  test("stable: p95 change < 20%", () => {
    const now = Date.now();
    const current = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(now - i * 60_000).toISOString(),
      hook: "h", tool: null, durationMs: 55, outcome: "ok" as const,
    }));
    const compare = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(now - 3_600_000 - i * 60_000).toISOString(),
      hook: "h", tool: null, durationMs: 50, outcome: "ok" as const,
    }));
    const trends = computeTrends([...current, ...compare], { windowHours: 1, compareHours: 1 });
    expect(trends.length).toBe(1);
    expect(trends[0]!.trend).toBe("stable");
  });

  test("no compare data → trend classified as 'new' (was silently 'stable' before v1.14 polish)", () => {
    const now = Date.now();
    const current = Array.from({ length: 5 }, (_, i) => ({
      ts: new Date(now - i * 60_000).toISOString(),
      hook: "h", tool: null, durationMs: 80, outcome: "ok" as const,
    }));
    const trends = computeTrends(current, { windowHours: 1, compareHours: 1 });
    expect(trends.length).toBe(1);
    expect(trends[0]!.trend).toBe("new");
    // deltaPct stays 0 when there's no baseline (can't compute a percentage),
    // but the distinct 'new' classification prevents silently masking real
    // regressions on hooks that only appeared in the current window.
    expect(trends[0]!.deltaPct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// renderCompact
// ---------------------------------------------------------------------------

describe("renderCompact", () => {
  test("empty records → empty string", () => {
    expect(renderCompact({ records: [], topN: 5 })).toBe("");
  });

  test("all records outside window → empty string", () => {
    const old = makeRecord("h", 50, "ok", 48 * 60); // 48h ago, window=24h
    expect(renderCompact({ records: [old], topN: 5, windowHours: 24 })).toBe("");
  });

  test("10 records with clear slow hook → top5 includes it", () => {
    const records: HookTimingRecord[] = [
      ...Array.from({ length: 5 }, () => makeRecord("fast-hook", 5)),
      ...Array.from({ length: 5 }, () => makeRecord("slow-monster", 999)),
    ];
    const out = renderCompact({ records, topN: 5 });
    expect(out).toContain("slow-monster");
    expect(out).toContain("fast-hook");
  });

  test("topN limits output lines", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord(`hook-${i}`, (i + 1) * 10)
    );
    const out = renderCompact({ records, topN: 3 });
    // Should have header line + "Top 3 slowest" + 3 hook lines = 5 lines total
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  test("output is non-empty for single record", () => {
    const records = [makeRecord("only-hook", 42)];
    const out = renderCompact({ records, topN: 5 });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("only-hook");
  });
});
