/**
 * savings-math.test.ts — invariants for the v1.18 Trust Pass.
 *
 * Covers:
 *   1. recordSaving never records negative savings, even when the caller
 *      passes compact > raw or negative inputs.
 *   2. `rawTotal` increments correctly across both backends (JSON + SQLite)
 *      and survives round-trips through readStats().
 *   3. Pricing is consistent between the efficiency-server's costFor() and
 *      scripts/savings-dashboard.ts fmtUsd() — same tokens → same USD.
 *   4. _pricing.ts fallback behavior: unknown model → default rate.
 *   5. recordSavingAccurate on cache hit credits full rawBytes (not the
 *      compact delta).
 *
 * Each test opens a temp stats.db / stats.json so the developer's real
 * ~/.ashlr/stats.* is never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

import {
  _setDbPathForTests,
  _resetConnection,
  readStats as readStatsSqlite,
  recordSaving as recordSavingSqlite,
} from "../servers/_stats-sqlite";

import {
  readStats as readStatsJson,
  recordSaving as recordSavingJson,
  _drainWrites,
  _resetMemCache,
  statsPath as jsonStatsPath,
} from "../servers/_stats";

import { costFor, pricing, pricingModel, PRICING_TABLE, DEFAULT_PRICING_MODEL } from "../servers/_pricing";

import { recordSavingAccurate } from "../servers/_accounting";

// -------------------------------------------------------------------------
// Sandbox setup: isolate HOME so both JSON + SQLite backends write to
// a scratch directory. Also reset any prior module state.
// -------------------------------------------------------------------------

let SANDBOX: string;
let PRIOR_HOME: string | undefined;
let PRIOR_BACKEND: string | undefined;
let PRIOR_SYNC: string | undefined;

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "ashlr-savings-math-"));
  PRIOR_HOME = process.env.HOME;
  PRIOR_BACKEND = process.env.ASHLR_STATS_BACKEND;
  PRIOR_SYNC = process.env.ASHLR_STATS_SYNC;
  process.env.HOME = SANDBOX;
  // JSON tests need sync-mode to land on disk before assertions.
  process.env.ASHLR_STATS_SYNC = "1";
  _resetMemCache();
  _setDbPathForTests(join(SANDBOX, "stats.db"));
});

afterEach(() => {
  _resetConnection();
  _setDbPathForTests(null);
  _resetMemCache();
  if (PRIOR_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = PRIOR_HOME;
  if (PRIOR_BACKEND === undefined) delete process.env.ASHLR_STATS_BACKEND;
  else process.env.ASHLR_STATS_BACKEND = PRIOR_BACKEND;
  if (PRIOR_SYNC === undefined) delete process.env.ASHLR_STATS_SYNC;
  else process.env.ASHLR_STATS_SYNC = PRIOR_SYNC;
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ok */ }
});

// -------------------------------------------------------------------------
// 1. Invariants on recordSaving (both backends)
// -------------------------------------------------------------------------

describe("recordSaving invariants", () => {
  it("never records negative savings on JSON backend when compact > raw", async () => {
    delete process.env.ASHLR_STATS_BACKEND; // JSON default
    const saved = await recordSavingJson(100, 500, "ashlr__grep", { sessionId: "inv1" });
    expect(saved).toBe(0);
    await _drainWrites();
    const s = await readStatsJson();
    expect(s.lifetime.tokensSaved).toBe(0);
  });

  it("never records negative savings on SQLite backend when compact > raw", async () => {
    const saved = await recordSavingSqlite(100, 500, "ashlr__grep", { sessionId: "inv1" });
    expect(saved).toBe(0);
    const s = await readStatsSqlite();
    expect(s.lifetime.tokensSaved).toBe(0);
  });

  it("handles non-finite inputs gracefully (JSON)", async () => {
    delete process.env.ASHLR_STATS_BACKEND;
    const saved = await recordSavingJson(Number.NaN as number, 0, "ashlr__read", { sessionId: "nan" });
    expect(saved).toBe(0);
    await _drainWrites();
    const s = await readStatsJson();
    expect(Number.isFinite(s.lifetime.tokensSaved)).toBe(true);
    expect(s.lifetime.tokensSaved).toBe(0);
    // rawTotal is optional; coerced 0 when absent. Accept either shape.
    expect(s.lifetime.rawTotal ?? 0).toBe(0);
  });

  it("handles non-finite inputs gracefully (SQLite)", async () => {
    const saved = await recordSavingSqlite(Number.NaN as number, 0, "ashlr__read", { sessionId: "nan" });
    expect(saved).toBe(0);
    const s = await readStatsSqlite();
    expect(Number.isFinite(s.lifetime.tokensSaved)).toBe(true);
    expect(s.lifetime.tokensSaved).toBe(0);
  });
});

// -------------------------------------------------------------------------
// 2. rawTotal tracking
// -------------------------------------------------------------------------

describe("rawTotal counter", () => {
  it("increments by ceil(raw/4) on each JSON recordSaving", async () => {
    delete process.env.ASHLR_STATS_BACKEND;
    await recordSavingJson(8000, 1000, "ashlr__read", { sessionId: "rt1" });
    await recordSavingJson(4000, 500, "ashlr__grep", { sessionId: "rt1" });
    await _drainWrites();
    const s = await readStatsJson();
    // rawTotal = ceil(8000/4) + ceil(4000/4) = 2000 + 1000 = 3000
    expect(s.lifetime.rawTotal).toBe(3000);
    // tokensSaved = ceil(7000/4) + ceil(3500/4) = 1750 + 875 = 2625
    expect(s.lifetime.tokensSaved).toBe(2625);
  });

  it("increments by ceil(raw/4) on each SQLite recordSaving", async () => {
    await recordSavingSqlite(8000, 1000, "ashlr__read", { sessionId: "rt1" });
    await recordSavingSqlite(4000, 500, "ashlr__grep", { sessionId: "rt1" });
    const s = await readStatsSqlite();
    expect(s.lifetime.rawTotal).toBe(3000);
    expect(s.lifetime.tokensSaved).toBe(2625);
  });

  it("treats missing rawTotal in old JSON files as 0 (backward compat)", async () => {
    delete process.env.ASHLR_STATS_BACKEND;
    // Write a v2 file WITHOUT rawTotal — simulates a pre-v1.18 install.
    const { writeFileSync, mkdirSync } = await import("fs");
    mkdirSync(join(SANDBOX, ".ashlr"), { recursive: true });
    writeFileSync(
      jsonStatsPath(),
      JSON.stringify({
        schemaVersion: 2,
        sessions: {},
        lifetime: { calls: 10, tokensSaved: 1234, byTool: {}, byDay: {} },
      }),
    );
    _resetMemCache();
    const s = await readStatsJson();
    // rawTotal is optional when absent/zero — coalesce for comparison.
    expect(s.lifetime.rawTotal ?? 0).toBe(0);
    // Prior counters survive.
    expect(s.lifetime.calls).toBe(10);
    expect(s.lifetime.tokensSaved).toBe(1234);
  });

  it("SQLite dispatcher path carries rawTotal through readStats", async () => {
    process.env.ASHLR_STATS_BACKEND = "sqlite";
    const { readStats, recordSaving: dispatchRecord } = await import("../servers/_stats");
    await dispatchRecord(10000, 2000, "ashlr__read", { sessionId: "disp" });
    const s = await readStats();
    expect(s.lifetime.rawTotal).toBe(2500); // ceil(10000/4)
  });
});

// -------------------------------------------------------------------------
// 3. Pricing consistency
// -------------------------------------------------------------------------

describe("pricing consistency", () => {
  it("costFor resolves to the default model when ASHLR_PRICING_MODEL is unset", () => {
    const prior = process.env.ASHLR_PRICING_MODEL;
    delete process.env.ASHLR_PRICING_MODEL;
    try {
      expect(pricingModel()).toBe(DEFAULT_PRICING_MODEL);
      expect(pricing().inUsd).toBe(PRICING_TABLE[DEFAULT_PRICING_MODEL]!.inUsd);
      // 1M tokens at $3/M = $3.
      expect(costFor(1_000_000)).toBeCloseTo(3.0, 6);
    } finally {
      if (prior === undefined) delete process.env.ASHLR_PRICING_MODEL;
      else process.env.ASHLR_PRICING_MODEL = prior;
    }
  });

  it("costFor switches to opus-4 rate when env var is set", () => {
    const prior = process.env.ASHLR_PRICING_MODEL;
    process.env.ASHLR_PRICING_MODEL = "opus-4";
    try {
      expect(pricingModel()).toBe("opus-4");
      expect(costFor(1_000_000)).toBeCloseTo(15.0, 6);
    } finally {
      if (prior === undefined) delete process.env.ASHLR_PRICING_MODEL;
      else process.env.ASHLR_PRICING_MODEL = prior;
    }
  });

  it("unknown model falls back to default instead of throwing", () => {
    const prior = process.env.ASHLR_PRICING_MODEL;
    process.env.ASHLR_PRICING_MODEL = "does-not-exist";
    try {
      expect(() => pricing()).not.toThrow();
      expect(pricing().inUsd).toBe(PRICING_TABLE[DEFAULT_PRICING_MODEL]!.inUsd);
    } finally {
      if (prior === undefined) delete process.env.ASHLR_PRICING_MODEL;
      else process.env.ASHLR_PRICING_MODEL = prior;
    }
  });

  it("dashboard fmtUsd agrees with efficiency-server costFor on same tokens", async () => {
    const prior = process.env.ASHLR_PRICING_MODEL;
    delete process.env.ASHLR_PRICING_MODEL;
    try {
      const { fmtUsd } = await import("../scripts/savings-dashboard");
      const tokens = 500_000;
      // Dashboard fmtUsd prefixes "~$" — strip it and parse.
      const dashUsd = parseFloat(fmtUsd(tokens).replace(/^~\$/, ""));
      const serverCost = costFor(tokens);
      // Values should match to within rounding (fmtUsd rounds to 2–4dp
      // depending on magnitude).
      expect(dashUsd).toBeCloseTo(serverCost, 2);
    } finally {
      if (prior === undefined) delete process.env.ASHLR_PRICING_MODEL;
      else process.env.ASHLR_PRICING_MODEL = prior;
    }
  });

  it("negative/non-finite tokens return 0", () => {
    expect(costFor(-100)).toBe(0);
    expect(costFor(Number.NaN)).toBe(0);
    expect(costFor(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// -------------------------------------------------------------------------
// 4. recordSavingAccurate cache-hit math
// -------------------------------------------------------------------------

describe("recordSavingAccurate cache-hit math", () => {
  it("miss: records `raw - compact` delta (unchanged behavior)", async () => {
    delete process.env.ASHLR_STATS_BACKEND;
    await recordSavingAccurate({ rawBytes: 4000, compactBytes: 1000, toolName: "ashlr__read", cacheHit: false });
    await _drainWrites();
    const s = await readStatsJson();
    // ceil((4000-1000)/4) = 750
    expect(s.lifetime.tokensSaved).toBe(750);
  });

  it("hit: records FULL rawBytes as saved (not raw - compact)", async () => {
    delete process.env.ASHLR_STATS_BACKEND;
    await recordSavingAccurate({ rawBytes: 4000, compactBytes: 200, toolName: "ashlr__read", cacheHit: true });
    await _drainWrites();
    const s = await readStatsJson();
    // On a cache hit we credit the full rawBytes — not the delta.
    // ceil(4000/4) = 1000 (not 950, which would be the delta).
    expect(s.lifetime.tokensSaved).toBe(1000);
  });
});
