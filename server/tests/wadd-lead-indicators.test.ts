/**
 * wadd-lead-indicators.test.ts — Server-side coverage for WAD-D lead-indicator
 * intake + aggregation.
 *
 * Scenarios:
 *   1. POST /stats/daily-active accepts a payload WITH lead_indicators and
 *      persists each column.
 *   2. POST /stats/daily-active accepts a payload WITHOUT lead_indicators
 *      (backward compat — older clients).
 *   3. POST /stats/daily-active rejects a malformed nudge_accept_rate (>1).
 *   4. Aggregator over a populated cohort emits real lead-indicator values.
 *   5. Aggregator over <10 reporters emits insufficient_data + nulls.
 *   6. Aggregator with a mix of NULL and populated rows still computes rates
 *      from only the populated subset (independent per-metric gating).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, getDb } from "../src/db.js";
import {
  LEAD_INDICATOR_MIN_ROWS,
  runDailyWadDAggregate,
} from "../src/jobs/daily-wad-d-aggregate.js";

const VALID_DATE = "2026-05-22";
const VALID_VERSION = "1.31.0";

function freshDb(): Database {
  const db = new Database(":memory:");
  _setDb(db);
  return db;
}

function hex(seed: string): string {
  // Deterministic, collision-resistant 64-char hex digest for tests. Uses
  // a simple djb2 fold over the seed then re-pads — avoids the prefix
  // collision the literal-pad version had (e.g. "mass_1" vs "mass_10").
  let h = 5381n;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5n) + h) ^ BigInt(seed.charCodeAt(i));
    h &= (1n << 64n) - 1n;
  }
  const tail = h.toString(16).padStart(16, "0");
  return (seed + ":" + tail)
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a");
}

async function post(body: unknown): Promise<Response> {
  return await app.fetch(new Request("http://localhost/stats/daily-active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => { freshDb(); });
afterEach(() => { _resetDb(); });

describe("POST /stats/daily-active — lead indicators", () => {
  it("accepts and persists a lead_indicators block", async () => {
    const res = await post({
      identity_hash: hex("alice"),
      date: VALID_DATE,
      plugin_version: VALID_VERSION,
      lead_indicators: {
        onboarding_completed: true,
        status_line_enabled: true,
        first_savings_at: "2026-05-22T10:00:00.000Z",
        streak_days: 5,
        savings_invocations_this_week: 3,
        nudge_accept_rate: 0.4,
      },
    });
    expect(res.status).toBe(202);

    const row = getDb()
      .query<{
        onboarding_completed: number | null;
        status_line_enabled: number | null;
        first_savings_at: string | null;
        streak_days: number | null;
        savings_invocations_this_week: number | null;
        nudge_accept_rate: number | null;
      }, []>(
        `SELECT onboarding_completed, status_line_enabled, first_savings_at,
                streak_days, savings_invocations_this_week, nudge_accept_rate
         FROM daily_active_records`,
      )
      .get();
    expect(row?.onboarding_completed).toBe(1);
    expect(row?.status_line_enabled).toBe(1);
    expect(row?.first_savings_at).toBe("2026-05-22T10:00:00.000Z");
    expect(row?.streak_days).toBe(5);
    expect(row?.savings_invocations_this_week).toBe(3);
    expect(row?.nudge_accept_rate).toBe(0.4);
  });

  it("accepts a payload WITHOUT lead_indicators (backward compat)", async () => {
    const res = await post({
      identity_hash: hex("bob"),
      date: VALID_DATE,
      plugin_version: VALID_VERSION,
    });
    expect(res.status).toBe(202);
    const row = getDb()
      .query<{ onboarding_completed: number | null; nudge_accept_rate: number | null }, []>(
        `SELECT onboarding_completed, nudge_accept_rate FROM daily_active_records`,
      )
      .get();
    expect(row?.onboarding_completed).toBeNull();
    expect(row?.nudge_accept_rate).toBeNull();
  });

  it("rejects nudge_accept_rate > 1", async () => {
    const res = await post({
      identity_hash: hex("carol"),
      date: VALID_DATE,
      plugin_version: VALID_VERSION,
      lead_indicators: { nudge_accept_rate: 1.5 },
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown lead_indicators key (strict schema guards PII leakage)", async () => {
    const res = await post({
      identity_hash: hex("dave"),
      date: VALID_DATE,
      plugin_version: VALID_VERSION,
      lead_indicators: { secret_field: "leak" },
    });
    expect(res.status).toBe(400);
  });

  it("upsert refreshes lead-indicator columns on a same-day re-post", async () => {
    const ident = hex("eve");
    await post({
      identity_hash: ident,
      date: VALID_DATE,
      plugin_version: VALID_VERSION,
      lead_indicators: { onboarding_completed: false, streak_days: 1 },
    });
    await post({
      identity_hash: ident,
      date: VALID_DATE,
      plugin_version: VALID_VERSION,
      lead_indicators: { onboarding_completed: true, streak_days: 2 },
    });
    const row = getDb()
      .query<{ onboarding_completed: number | null; streak_days: number | null }, []>(
        `SELECT onboarding_completed, streak_days FROM daily_active_records WHERE identity_hash = ?`,
      )
      .get(ident as unknown as string);
    expect(row?.onboarding_completed).toBe(1);
    expect(row?.streak_days).toBe(2);
  });
});

describe("runDailyWadDAggregate — lead indicators", () => {
  function insertActive(
    identity: string,
    date: string,
    indicators: {
      onboarding_completed?: 0 | 1;
      status_line_enabled?: 0 | 1;
      first_savings_at?: string | null;
      streak_days?: number;
      savings_invocations_this_week?: number;
      nudge_accept_rate?: number;
    } = {},
  ): void {
    getDb().run(
      `INSERT OR IGNORE INTO daily_active_records
         (identity_hash, github_hash, active_date, plugin_version,
          onboarding_completed, status_line_enabled, first_savings_at,
          streak_days, savings_invocations_this_week, nudge_accept_rate)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity,
        date,
        VALID_VERSION,
        indicators.onboarding_completed ?? null,
        indicators.status_line_enabled ?? null,
        indicators.first_savings_at ?? null,
        indicators.streak_days ?? null,
        indicators.savings_invocations_this_week ?? null,
        indicators.nudge_accept_rate ?? null,
      ],
    );
  }

  it("emits insufficient_data + nulls when cohort < 10", () => {
    insertActive(hex("u1"), VALID_DATE, { onboarding_completed: 1, streak_days: 5 });
    insertActive(hex("u2"), VALID_DATE, { onboarding_completed: 0, streak_days: 1 });
    const result = runDailyWadDAggregate({ snapshotDate: VALID_DATE });
    expect(result.lead_indicators.insufficient_data).toBe(true);
    expect(result.lead_indicators.onboarding_completion_rate).toBeNull();
    expect(result.lead_indicators.median_streak_days).toBeNull();
    expect(result.lead_indicators.reporting_identities).toBe(2);
  });

  it("computes rates over a cohort of 10+ populated reporters", () => {
    // 12 reporters: 8 onboarding=true, 6 status-line=true, all-12 with
    // every metric so every per-metric gate is satisfied (>=10 populated).
    for (let i = 0; i < 12; i++) {
      const id = hex(`mass_${i}`);
      insertActive(id, VALID_DATE, {
        onboarding_completed: i < 8 ? 1 : 0,
        status_line_enabled: i < 6 ? 1 : 0,
        streak_days: i + 1,
        savings_invocations_this_week: 2,
        nudge_accept_rate: 0.5,
        first_savings_at: `${VALID_DATE}T10:00:00.000Z`,
      });
    }
    const result = runDailyWadDAggregate({ snapshotDate: VALID_DATE });
    const li = result.lead_indicators;
    expect(li.insufficient_data).toBe(false);
    expect(li.reporting_identities).toBe(12);
    expect(li.onboarding_completion_rate).toBeCloseTo(0.667, 2); // 8/12
    expect(li.status_line_opt_in_rate).toBe(0.5);                // 6/12
    expect(li.first_savings_within_30min_rate).toBe(1);          // 12/12 on day 0
    // streak_days = [1..12] → median = 6.5
    expect(li.median_streak_days).toBe(6.5);
    // sum of 2 across 12 reporters = 24
    expect(li.weekly_savings_invocations_total).toBe(24);
    // median of [0.5 x 12] = 0.5
    expect(li.nudge_accept_rate_median).toBe(0.5);
  });

  it("per-metric gating: streak rate ungated even when nudge rate is", () => {
    // 12 reporters with streak_days; only 3 with nudge_accept_rate.
    for (let i = 0; i < 12; i++) {
      const id = hex(`s_${i}`);
      insertActive(id, VALID_DATE, {
        streak_days: 3,
        nudge_accept_rate: i < 3 ? 0.5 : undefined,
      });
    }
    const result = runDailyWadDAggregate({ snapshotDate: VALID_DATE });
    expect(result.lead_indicators.median_streak_days).toBe(3);
    expect(result.lead_indicators.nudge_accept_rate_median).toBeNull();
    expect(result.lead_indicators.insufficient_data).toBe(false);
  });

  it("persists the new lead-indicators JSON", () => {
    for (let i = 0; i < LEAD_INDICATOR_MIN_ROWS; i++) {
      insertActive(hex(`p_${i}`), VALID_DATE, { onboarding_completed: 1, streak_days: 4 });
    }
    runDailyWadDAggregate({ snapshotDate: VALID_DATE });
    const row = getDb()
      .query<{ lead_indicators_json: string }, [string]>(
        `SELECT lead_indicators_json FROM wad_d_snapshots WHERE snapshot_date = ?`,
      )
      .get(VALID_DATE);
    expect(row?.lead_indicators_json).toBeTruthy();
    const parsed = JSON.parse(row!.lead_indicators_json) as Record<string, unknown>;
    expect(parsed["onboarding_completion_rate"]).toBe(1);
    expect(parsed["median_streak_days"]).toBe(4);
    expect("client_instrumentation_pending" in parsed).toBe(false);
  });
});
