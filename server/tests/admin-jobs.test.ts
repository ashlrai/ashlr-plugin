/**
 * admin-jobs.test.ts — Tests for POST /admin/jobs/daily-wad-d-aggregate.
 *
 * Covers:
 *   1.  Missing bearer header           -> 401
 *   2.  Wrong bearer                    -> 401
 *   3.  Right bearer + token unset      -> 503 (NOT 401 — surface off)
 *   4.  Right bearer + token set        -> 200, aggregator invoked once
 *   5.  Response shape contains ok, snapshotDate, wadD, leadIndicators
 *   6.  dryRun=true is propagated to the aggregator
 *   7.  date + thresholdDays propagate too
 *   8.  Aggregator throw                -> 500, internal message NOT leaked
 *   9.  Malformed body                  -> 400
 *  10.  Different-length bearer         -> 401 cleanly
 *  11.  Empty body (no JSON)            -> 200 (options optional)
 *
 * Note: we avoid `mock.module()` because bun:test patches the module registry
 * process-wide and the swap leaks across files. Instead the route exposes
 * `_setWadDAggregator(fn)` as a test seam.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb } from "../src/db.js";
import { _setWadDAggregator } from "../src/routes/admin-jobs.js";
import type { RunResult } from "../src/jobs/daily-wad-d-aggregate.js";

const TRIGGER_TOKEN = "test-trigger-token-1234567890abcdef";
const ENDPOINT = "/admin/jobs/daily-wad-d-aggregate";

function defaultResult(): RunResult {
  return {
    snapshot_date: "2026-05-22",
    wad_d_value: 7,
    lead_indicators: {
      identities_seen: 12,
      identities_1d_plus: 12,
      identities_3d_plus: 9,
      identities_5d_plus: 7,
      identities_7d_plus: 3,
      median_active_days: 4,
      onboarding_completion_rate: null,
      status_line_opt_in_rate: null,
      first_savings_within_30min_rate: null,
      median_streak_days: null,
      weekly_savings_invocations_total: null,
      nudge_accept_rate_median: null,
      insufficient_data: true,
      reporting_identities: 0,
    },
    written: true,
  };
}

type Call = { opts: unknown };
let calls: Call[] = [];

function makeMockAggregator(result: RunResult = defaultResult()) {
  return (opts?: unknown) => {
    calls.push({ opts });
    return result;
  };
}

function postJob(body: unknown, token?: string | null) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token !== undefined && token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return app.request(ENDPOINT, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /admin/jobs/daily-wad-d-aggregate", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    _setDb(db);
    calls = [];
    _setWadDAggregator(makeMockAggregator());
    process.env["ASHLR_ADMIN_TRIGGER_TOKEN"] = TRIGGER_TOKEN;
  });

  afterEach(() => {
    _resetDb();
    _setWadDAggregator(null); // restore the real aggregator
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
  });

  // 1.  Missing bearer header -> 401
  it("returns 401 when Authorization header is missing", async () => {
    const res = await postJob({});
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("Unauthorized");
    expect(body.requestId).toBeDefined();
    expect(calls.length).toBe(0);
  });

  // 2.  Wrong bearer -> 401
  it("returns 401 when bearer token is wrong", async () => {
    const res = await postJob({}, "definitely-not-the-token");
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  // 3.  Right bearer + token unset on server -> 503
  it("returns 503 (NOT 401) when server has no ASHLR_ADMIN_TRIGGER_TOKEN", async () => {
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
    const res = await postJob({}, TRIGGER_TOKEN);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("disabled");
    expect(calls.length).toBe(0);
  });

  // 4. Right bearer -> 200, aggregator called once
  it("returns 200 and invokes aggregator exactly once on valid bearer", async () => {
    const res = await postJob({}, TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
  });

  // 5. Response shape
  it("returns response shape: { ok, snapshotDate, wadD, leadIndicators, written, requestId }", async () => {
    const res = await postJob({}, TRIGGER_TOKEN);
    const body = (await res.json()) as {
      ok: boolean;
      snapshotDate: string;
      wadD: number;
      leadIndicators: { identities_5d_plus: number };
      written: boolean;
      requestId: string;
    };
    expect(body.ok).toBe(true);
    expect(body.snapshotDate).toBe("2026-05-22");
    expect(body.wadD).toBe(7);
    expect(body.leadIndicators).toBeDefined();
    expect(body.leadIndicators.identities_5d_plus).toBe(7);
    expect(body.written).toBe(true);
    expect(typeof body.requestId).toBe("string");
  });

  // 6. dryRun=true propagation
  it("propagates dryRun=true to the aggregator", async () => {
    const res = await postJob({ dryRun: true }, TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.opts).toMatchObject({ dryRun: true });
  });

  // 7. date + thresholdDays propagation
  it("propagates date and thresholdDays to the aggregator", async () => {
    const res = await postJob(
      { date: "2026-05-01", thresholdDays: 3 },
      TRIGGER_TOKEN,
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.opts).toMatchObject({ snapshotDate: "2026-05-01", thresholdDays: 3 });
  });

  // 8. Aggregator throw -> 500, internal details NOT leaked
  it("returns 500 with redacted error message when aggregator throws", async () => {
    _setWadDAggregator(() => {
      throw new Error("INTERNAL: SQLITE_CORRUPT at /data/ashlr.db row 7421");
    });
    const res = await postJob({}, TRIGGER_TOKEN);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("Aggregator failed");
    const blob = JSON.stringify(body);
    expect(blob).not.toContain("SQLITE_CORRUPT");
    expect(blob).not.toContain("/data/ashlr.db");
    expect(body.requestId).toBeDefined();
  });

  // 9. Malformed body -> 400
  it("returns 400 for malformed body (bad date format)", async () => {
    const res = await postJob({ date: "not-a-date" }, TRIGGER_TOKEN);
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  // 10. Different-length bearer -> 401 cleanly (no crash from timingSafeEqual)
  it("rejects different-length bearer cleanly without crashing", async () => {
    const res = await postJob({}, "x");
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  // 11. Empty body (no JSON) is OK — body is optional
  it("accepts empty body as valid (all options optional)", async () => {
    const res = await app.request(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TRIGGER_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
  });
});
