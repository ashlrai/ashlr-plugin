/**
 * admin-orchestration-usage.test.ts — Tests for GET /admin/orchestration-usage.
 *
 * Covers (8 tests):
 *   1.  Missing bearer header        -> 401
 *   2.  Wrong bearer                 -> 401
 *   3.  Token unset                  -> 503
 *   4.  Empty data                   -> { month, buckets: [] }
 *   5.  3 buckets at 50/170/210      -> throttle_states ok/warn/throttled
 *   6.  top=1 limits results
 *   7.  Default month is current UTC month
 *   8.  Invalid ?month=YYYY-MM       -> 400
 *
 * Uses the _setOrchestrationUsageReader DI seam — same pattern as the
 * orchestration-runs admin tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb } from "../src/db.js";
import {
  _setOrchestrationUsageReader,
  type UsageBucket,
  type UsageBucketRow,
  currentMonthUtc,
} from "../src/routes/admin-orchestration-usage.js";

const TRIGGER_TOKEN = "test-trigger-token-1234567890abcdef";
const ENDPOINT = "/admin/orchestration-usage";

type Call = { month: string; top: number };
let calls: Call[] = [];

function makeMockReader(rows: UsageBucketRow[] = []) {
  return (month: string, top: number) => {
    calls.push({ month, top });
    return rows.slice(0, top);
  };
}

function getUsage(query: string = "", token?: string | null) {
  const headers: Record<string, string> = {};
  if (token !== undefined && token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const url = query ? `${ENDPOINT}?${query}` : ENDPOINT;
  return app.request(url, { method: "GET", headers });
}

describe("GET /admin/orchestration-usage", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    _setDb(db);
    calls = [];
    _setOrchestrationUsageReader(makeMockReader());
    process.env["ASHLR_ADMIN_TRIGGER_TOKEN"] = TRIGGER_TOKEN;
  });

  afterEach(() => {
    _resetDb();
    _setOrchestrationUsageReader(null);
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await getUsage();
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it("returns 401 when bearer is wrong (constant-time, no crash)", async () => {
    const res = await getUsage("", "definitely-not-the-token-and-same-length-ish");
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
    // Different-length bearer must also not crash.
    const res2 = await getUsage("", "x");
    expect(res2.status).toBe(401);
  });

  it("returns 503 (NOT 401) when ASHLR_ADMIN_TRIGGER_TOKEN is unset", async () => {
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
    const res = await getUsage("", TRIGGER_TOKEN);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("disabled");
    expect(calls.length).toBe(0);
  });

  it("returns { month, buckets: [] } for empty data", async () => {
    _setOrchestrationUsageReader(makeMockReader([]));
    const res = await getUsage("month=2026-05", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { month: string; buckets: UsageBucket[] };
    expect(body.month).toBe("2026-05");
    expect(body.buckets).toEqual([]);
  });

  it("derives throttle_state correctly: 50/170/210 -> ok/warn/throttled", async () => {
    // Cap = 200. Soft-throttle at 80% (= 160). At-or-above 100% (= 200) is
    // throttled. Use 50 (25%), 170 (85%), 210 (105%).
    _setOrchestrationUsageReader(
      makeMockReader([
        {
          team_bucket: "a".repeat(64),
          graphs_run: 210, agents_spawned: 50,
          tokens_in: 100_000, tokens_out: 5_000,
        },
        {
          team_bucket: "b".repeat(64),
          graphs_run: 170, agents_spawned: 40,
          tokens_in: 70_000, tokens_out: 3_500,
        },
        {
          team_bucket: "c".repeat(64),
          graphs_run: 50, agents_spawned: 10,
          tokens_in: 20_000, tokens_out: 1_000,
        },
      ]),
    );

    const res = await getUsage("month=2026-05", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { month: string; buckets: UsageBucket[] };
    expect(body.buckets.length).toBe(3);

    const byBucket = new Map(body.buckets.map((b) => [b.team_bucket[0], b]));
    const a = byBucket.get("a")!;
    const b = byBucket.get("b")!;
    const c = byBucket.get("c")!;

    expect(a.graphs_run).toBe(210);
    expect(a.percent_of_cap).toBe(1.05);
    expect(a.throttle_state).toBe("throttled");

    expect(b.graphs_run).toBe(170);
    expect(b.percent_of_cap).toBe(0.85);
    expect(b.throttle_state).toBe("warn");

    expect(c.graphs_run).toBe(50);
    expect(c.percent_of_cap).toBe(0.25);
    expect(c.throttle_state).toBe("ok");
  });

  it("respects ?top=1 to limit results", async () => {
    _setOrchestrationUsageReader(
      makeMockReader([
        {
          team_bucket: "a".repeat(64),
          graphs_run: 100, agents_spawned: 20,
          tokens_in: 1000, tokens_out: 100,
        },
        {
          team_bucket: "b".repeat(64),
          graphs_run: 50, agents_spawned: 10,
          tokens_in: 500, tokens_out: 50,
        },
      ]),
    );

    const res = await getUsage("top=1", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls[0]!.top).toBe(1);
    const body = (await res.json()) as { buckets: UsageBucket[] };
    expect(body.buckets.length).toBe(1);
    expect(body.buckets[0]!.team_bucket[0]).toBe("a");
  });

  it("defaults to current UTC month when ?month is omitted", async () => {
    const res = await getUsage("", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls[0]!.month).toBe(currentMonthUtc());
    const body = (await res.json()) as { month: string };
    expect(body.month).toBe(currentMonthUtc());
  });

  it("returns 400 for malformed ?month input", async () => {
    const res1 = await getUsage("month=2026-13", TRIGGER_TOKEN);
    expect(res1.status).toBe(400);

    const res2 = await getUsage("month=2026-5", TRIGGER_TOKEN);
    expect(res2.status).toBe(400);

    const res3 = await getUsage("month=not-a-date", TRIGGER_TOKEN);
    expect(res3.status).toBe(400);

    // The reader should never have been called for any of these.
    expect(calls.length).toBe(0);
  });

  it("caps ?top at 500 and falls back to default for invalid input", async () => {
    const res1 = await getUsage("top=5000", TRIGGER_TOKEN);
    expect(res1.status).toBe(200);
    expect(calls[0]!.top).toBe(500);

    calls = [];
    const res2 = await getUsage("top=-3", TRIGGER_TOKEN);
    expect(res2.status).toBe(200);
    expect(calls[0]!.top).toBe(50);

    calls = [];
    const res3 = await getUsage("top=abc", TRIGGER_TOKEN);
    expect(res3.status).toBe(200);
    expect(calls[0]!.top).toBe(50);
  });

  it("default reader hits real DB and orders by graphs_run DESC", async () => {
    _setOrchestrationUsageReader(null); // use defaultReadUsage against in-memory db
    const db = new Database(":memory:");
    _setDb(db);

    db.run(
      `INSERT INTO orchestration_usage
         (team_bucket, month_key, graphs_run, agents_spawned, tokens_in, tokens_out)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["a".repeat(64), "2026-05", 250, 60, 50_000, 2_500],
    );
    db.run(
      `INSERT INTO orchestration_usage
         (team_bucket, month_key, graphs_run, agents_spawned, tokens_in, tokens_out)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["b".repeat(64), "2026-05", 30, 5, 5_000, 200],
    );
    // Different month — should be excluded.
    db.run(
      `INSERT INTO orchestration_usage
         (team_bucket, month_key, graphs_run, agents_spawned, tokens_in, tokens_out)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["c".repeat(64), "2026-04", 999, 50, 99_000, 9_000],
    );

    const res = await getUsage("month=2026-05", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { month: string; buckets: UsageBucket[] };
    expect(body.month).toBe("2026-05");
    expect(body.buckets.length).toBe(2);
    // ORDER BY graphs_run DESC -> a (250) before b (30)
    expect(body.buckets[0]!.graphs_run).toBe(250);
    expect(body.buckets[0]!.throttle_state).toBe("throttled");
    expect(body.buckets[1]!.graphs_run).toBe(30);
    expect(body.buckets[1]!.throttle_state).toBe("ok");
  });
});
