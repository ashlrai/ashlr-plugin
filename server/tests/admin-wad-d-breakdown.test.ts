/**
 * admin-wad-d-breakdown.test.ts — Tests for GET /admin/wad-d-breakdown.
 *
 * Covers:
 *   1.  Missing bearer header           -> 401
 *   2.  Wrong bearer                    -> 401
 *   3.  Right bearer + token unset      -> 503 (NOT 401 — surface off)
 *   4.  Right bearer + empty data       -> 200, zeroed segments
 *   5.  Default days=30 when omitted, response window honors it
 *   6.  days cap at 365 (days=10000 -> window.days == 365)
 *   7.  Segment math: logged_in vs anonymous split + WAD-D correctness
 *   8.  Lead-indicator rates compute per-segment (no cross-bleed)
 *   9.  Movers panel returns up to 3 entries sorted by |delta| desc
 *
 * Mirrors admin-wad-d.test.ts shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb } from "../src/db.js";
import {
  _setWadDBreakdownReader,
  type DailyActiveRow,
} from "../src/routes/admin-wad-d-breakdown.js";

const TRIGGER_TOKEN = "test-trigger-token-1234567890abcdef";
const ENDPOINT = "/admin/wad-d-breakdown";

type Call = { from: string; to: string };
let calls: Call[] = [];

function makeMockReader(rows: DailyActiveRow[]) {
  return (from: string, to: string) => {
    calls.push({ from, to });
    return rows.filter((r) => r.active_date >= from && r.active_date <= to);
  };
}

/**
 * Build a row helper. All lead-indicator fields default to null so tests
 * only set what they care about.
 */
function row(over: Partial<DailyActiveRow> & Pick<DailyActiveRow, "identity_hash" | "active_date">): DailyActiveRow {
  return {
    github_hash: null,
    onboarding_completed: null,
    status_line_enabled: null,
    first_savings_at: null,
    streak_days: null,
    savings_invocations_this_week: null,
    nudge_accept_rate: null,
    ...over,
  };
}

function getBreakdown(query: string = "", token?: string | null) {
  const headers: Record<string, string> = {};
  if (token !== undefined && token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const url = query ? `${ENDPOINT}?${query}` : ENDPOINT;
  return app.request(url, { method: "GET", headers });
}

/** Today (UTC) and N days back, matching the route's internals. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n: number): string {
  const t = new Date(`${today()}T00:00:00Z`).getTime();
  return new Date(t - n * 86_400_000).toISOString().slice(0, 10);
}

describe("GET /admin/wad-d-breakdown", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    _setDb(db);
    calls = [];
    _setWadDBreakdownReader(makeMockReader([]));
    process.env["ASHLR_ADMIN_TRIGGER_TOKEN"] = TRIGGER_TOKEN;
  });

  afterEach(() => {
    _resetDb();
    _setWadDBreakdownReader(null);
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
  });

  // 1. Missing bearer -> 401
  it("returns 401 when Authorization header is missing", async () => {
    const res = await getBreakdown();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("Unauthorized");
    expect(body.requestId).toBeDefined();
    expect(calls.length).toBe(0);
  });

  // 2. Wrong bearer -> 401
  it("returns 401 when bearer token is wrong", async () => {
    const res = await getBreakdown("", "definitely-not-the-token-same-length-ish-x");
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  // 3. Right bearer + token unset on server -> 503
  it("returns 503 (NOT 401) when server has no ASHLR_ADMIN_TRIGGER_TOKEN", async () => {
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
    const res = await getBreakdown("", TRIGGER_TOKEN);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("disabled");
    expect(calls.length).toBe(0);
  });

  // 4. Right bearer + empty data -> 200 with zeroed segments
  it("returns 200 with zeroed segments when no rows exist", async () => {
    const res = await getBreakdown("", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window: { days: number; from: string; to: string };
      totals: { wad_d: number; identities_seen: number };
      segments: { logged_in: { wad_d: number }; anonymous: { wad_d: number } };
      top_lead_indicators_movers: unknown[];
    };
    expect(body.window.days).toBe(30);
    expect(body.totals.wad_d).toBe(0);
    expect(body.totals.identities_seen).toBe(0);
    expect(body.segments.logged_in.wad_d).toBe(0);
    expect(body.segments.anonymous.wad_d).toBe(0);
    expect(Array.isArray(body.top_lead_indicators_movers)).toBe(true);
  });

  // 5. Default days=30 when omitted, reader called with matching window
  it("defaults to days=30 when ?days is omitted", async () => {
    const res = await getBreakdown("", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window: { days: number; from: string; to: string } };
    expect(body.window.days).toBe(30);
    expect(body.window.to).toBe(today());
    expect(body.window.from).toBe(daysAgo(29));
    // Reader called twice: once for the main window, once for the prior 7d.
    expect(calls.length).toBe(2);
  });

  // 6. days cap at 365
  it("caps ?days at 365 when caller asks for more", async () => {
    const res = await getBreakdown("days=10000", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window: { days: number } };
    expect(body.window.days).toBe(365);
  });

  // 7. Segment math: logged_in vs anonymous + WAD-D >=5-of-7 rule
  it("splits logged_in vs anonymous and computes WAD-D over the last 7 days", async () => {
    // Build a row set where:
    //   - github_hash "gh-A" hits 5 of last 7 days (logged_in active)
    //   - github_hash "gh-B" hits only 2 of last 7 days (logged_in inactive)
    //   - identity_hash "anon-1" (no github_hash) hits 6 of last 7 days (anon active)
    //   - identity_hash "anon-2" (no github_hash) hits 1 day (anon inactive)
    const rows: DailyActiveRow[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(row({ identity_hash: "id-A-m1", github_hash: "gh-A", active_date: daysAgo(i) }));
    }
    for (let i = 0; i < 2; i++) {
      rows.push(row({ identity_hash: "id-B-m1", github_hash: "gh-B", active_date: daysAgo(i) }));
    }
    for (let i = 0; i < 6; i++) {
      rows.push(row({ identity_hash: "anon-1", active_date: daysAgo(i) }));
    }
    rows.push(row({ identity_hash: "anon-2", active_date: daysAgo(3) }));

    _setWadDBreakdownReader(makeMockReader(rows));

    const res = await getBreakdown("days=30", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { wad_d: number; identities_seen: number };
      segments: {
        logged_in: { wad_d: number; identities_seen: number };
        anonymous: { wad_d: number; identities_seen: number };
      };
    };

    // Total identities (folded by COALESCE(github_hash, identity_hash)):
    //   gh-A, gh-B, anon-1, anon-2 = 4
    expect(body.totals.identities_seen).toBe(4);
    // Total WAD-D (>=5 of 7): gh-A (5) + anon-1 (6) = 2
    expect(body.totals.wad_d).toBe(2);

    // Logged-in: 2 identities, 1 active
    expect(body.segments.logged_in.identities_seen).toBe(2);
    expect(body.segments.logged_in.wad_d).toBe(1);

    // Anonymous: 2 identities, 1 active
    expect(body.segments.anonymous.identities_seen).toBe(2);
    expect(body.segments.anonymous.wad_d).toBe(1);
  });

  // 8. Lead-indicator rates compute per segment with no cross-bleed
  it("computes lead-indicator rates per segment with no cross-bleed", async () => {
    // Logged-in segment: 2 identities, both with onboarding_completed=1
    // Anonymous segment: 2 identities, both with onboarding_completed=0
    const rows: DailyActiveRow[] = [
      row({ identity_hash: "id-A", github_hash: "gh-A", active_date: daysAgo(0), onboarding_completed: 1 }),
      row({ identity_hash: "id-B", github_hash: "gh-B", active_date: daysAgo(0), onboarding_completed: 1 }),
      row({ identity_hash: "anon-1", active_date: daysAgo(0), onboarding_completed: 0 }),
      row({ identity_hash: "anon-2", active_date: daysAgo(0), onboarding_completed: 0 }),
    ];
    _setWadDBreakdownReader(makeMockReader(rows));

    const res = await getBreakdown("days=30", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      segments: {
        logged_in: { onboarding_completion_rate: number | null };
        anonymous: { onboarding_completion_rate: number | null };
      };
    };
    expect(body.segments.logged_in.onboarding_completion_rate).toBe(1);
    expect(body.segments.anonymous.onboarding_completion_rate).toBe(0);
  });

  // 9. Movers panel returns up to 3 entries sorted by |delta| desc
  it("returns top movers sorted by |delta| desc, max 3", async () => {
    // The route makes TWO calls to the reader: one for the dashboard window
    // (from..to == days 0..days-1) and one for the prior 7d (days 7..13).
    // Dispatch on `from` so each call returns a distinct row set and the
    // dashboard rollup doesn't get mixed with prior-window data.
    const currentRows: DailyActiveRow[] = [];
    const prevRows: DailyActiveRow[] = [];
    // Dashboard window: 10 identities with onboarding=1, streak=3
    for (let i = 0; i < 10; i++) {
      currentRows.push(row({
        identity_hash: `cur-${i}`,
        github_hash: `gh-cur-${i}`,
        active_date: daysAgo(i % 7),
        onboarding_completed: 1,
        streak_days: 3,
      }));
    }
    // Prior 7d: 10 identities with onboarding=0, streak=5
    for (let i = 0; i < 10; i++) {
      prevRows.push(row({
        identity_hash: `prev-${i}`,
        github_hash: `gh-prev-${i}`,
        active_date: daysAgo(7 + (i % 7)),
        onboarding_completed: 0,
        streak_days: 5,
      }));
    }
    // Dispatch by `from`:
    //   from == daysAgo(13) -> prior window
    //   otherwise           -> dashboard window
    const prevFromSentinel = daysAgo(13);
    _setWadDBreakdownReader((from, to) => {
      calls.push({ from, to });
      const src = from === prevFromSentinel ? prevRows : currentRows;
      return src.filter((r) => r.active_date >= from && r.active_date <= to);
    });

    const res = await getBreakdown("days=30", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      top_lead_indicators_movers: Array<{
        indicator: string;
        current: number | null;
        prev: number | null;
        delta: number | null;
      }>;
    };
    expect(body.top_lead_indicators_movers.length).toBeGreaterThan(0);
    expect(body.top_lead_indicators_movers.length).toBeLessThanOrEqual(3);
    // Biggest |delta| should be median_streak_days: 3 - 5 = -2.
    const first = body.top_lead_indicators_movers[0]!;
    expect(first.indicator).toBe("median_streak_days");
    expect(first.delta).toBe(-2);
    // onboarding_completion_rate should be in the list with delta=+1.
    const onboarding = body.top_lead_indicators_movers.find(
      (m) => m.indicator === "onboarding_completion_rate",
    );
    expect(onboarding).toBeDefined();
    expect(onboarding!.delta).toBe(1);
  });
});
