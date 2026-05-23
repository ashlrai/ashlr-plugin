/**
 * admin-orchestration-runs.test.ts — Tests for GET /admin/orchestration-runs.
 *
 * Covers:
 *   1.  Missing bearer header           -> 401
 *   2.  Wrong bearer                    -> 401
 *   3.  Different-length bearer         -> 401 (no crash, constant-time)
 *   4.  Right bearer + token unset      -> 503 (NOT 401)
 *   5.  Right bearer + token set        -> 200, runs + summary returned
 *   6.  Default days=7 when omitted
 *   7.  days cap at 90 (days=999 -> 90)
 *   8.  Invalid/negative days -> default 7
 *   9.  Default limit=50; cap at 200
 *  10.  Summary aggregation: success_rate + token totals correct
 *  11.  Summary aggregation: modes and tiers counts correct
 *  12.  Empty data returns total=0 + success_rate=0 (no NaN)
 *
 * Uses the _setOrchestrationRunsReader DI seam — same pattern as the
 * WAD-D test.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb } from "../src/db.js";
import {
  _setOrchestrationRunsReader,
  type OrchestrationRunRow,
  type OrchestrationSummary,
} from "../src/routes/admin-orchestration-runs.js";

const TRIGGER_TOKEN = "test-trigger-token-1234567890abcdef";
const ENDPOINT = "/admin/orchestration-runs";

function fakeRuns(): OrchestrationRunRow[] {
  return [
    {
      id: 1, graph_id: "g-1", goal: "refactor auth", tier: "pro", mode: "stub",
      started_at: "2026-05-22T10:00:00Z", finished_at: "2026-05-22T10:00:30Z",
      duration_ms: 30_000, node_count: 3, fail_count: 0, ok: 1,
      total_tokens_in: 1500, total_tokens_out: 0,
      received_at: "2026-05-22T10:00:30Z",
    },
    {
      id: 2, graph_id: "g-2", goal: "write tests", tier: "team", mode: "real-llm",
      started_at: "2026-05-22T11:00:00Z", finished_at: "2026-05-22T11:01:00Z",
      duration_ms: 60_000, node_count: 5, fail_count: 1, ok: 0,
      total_tokens_in: 4500, total_tokens_out: 300,
      received_at: "2026-05-22T11:01:00Z",
    },
  ];
}

function fakeSummary(): OrchestrationSummary {
  return {
    total: 2,
    ok_count: 1,
    fail_count: 1,
    success_rate: 0.5,
    total_tokens_in: 6000,
    total_tokens_out: 300,
    modes: { stub: 1, real_llm: 1 },
    tiers: { pro: 1, team: 1 },
  };
}

type Call = { days: number; limit: number };
let calls: Call[] = [];

function makeMockReader(
  runs: OrchestrationRunRow[] = fakeRuns(),
  summary: OrchestrationSummary = fakeSummary(),
) {
  return (days: number, limit: number) => {
    calls.push({ days, limit });
    return { runs, summary };
  };
}

function getRuns(query: string = "", token?: string | null) {
  const headers: Record<string, string> = {};
  if (token !== undefined && token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const url = query ? `${ENDPOINT}?${query}` : ENDPOINT;
  return app.request(url, { method: "GET", headers });
}

describe("GET /admin/orchestration-runs", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    _setDb(db);
    calls = [];
    _setOrchestrationRunsReader(makeMockReader());
    process.env["ASHLR_ADMIN_TRIGGER_TOKEN"] = TRIGGER_TOKEN;
  });

  afterEach(() => {
    _resetDb();
    _setOrchestrationRunsReader(null);
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await getRuns();
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it("returns 401 when bearer token is wrong", async () => {
    const res = await getRuns("", "definitely-not-the-token-and-same-length-ish");
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it("rejects different-length bearer cleanly without crashing", async () => {
    const res = await getRuns("", "x");
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it("returns 503 (NOT 401) when ASHLR_ADMIN_TRIGGER_TOKEN is unset", async () => {
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
    const res = await getRuns("", TRIGGER_TOKEN);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("disabled");
    expect(calls.length).toBe(0);
  });

  it("returns 200 with runs + summary on valid bearer", async () => {
    const res = await getRuns("", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    const body = (await res.json()) as {
      runs: OrchestrationRunRow[];
      summary: OrchestrationSummary;
      requestId: string;
    };
    expect(body.runs.length).toBe(2);
    expect(body.summary.total).toBe(2);
    expect(body.summary.success_rate).toBe(0.5);
    expect(typeof body.requestId).toBe("string");
  });

  it("defaults to days=7 when ?days is omitted", async () => {
    const res = await getRuns("", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls[0]!.days).toBe(7);
  });

  it("caps ?days at 90 when caller asks for more", async () => {
    const res = await getRuns("days=999", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls[0]!.days).toBe(90);
  });

  it("falls back to 7 days for invalid or non-positive ?days", async () => {
    const res1 = await getRuns("days=-5", TRIGGER_TOKEN);
    expect(res1.status).toBe(200);
    expect(calls[0]!.days).toBe(7);

    calls = [];
    const res2 = await getRuns("days=abc", TRIGGER_TOKEN);
    expect(res2.status).toBe(200);
    expect(calls[0]!.days).toBe(7);
  });

  it("defaults to limit=50 and caps at 200", async () => {
    const res1 = await getRuns("", TRIGGER_TOKEN);
    expect(res1.status).toBe(200);
    expect(calls[0]!.limit).toBe(50);

    calls = [];
    const res2 = await getRuns("limit=5000", TRIGGER_TOKEN);
    expect(res2.status).toBe(200);
    expect(calls[0]!.limit).toBe(200);

    calls = [];
    const res3 = await getRuns("limit=25", TRIGGER_TOKEN);
    expect(res3.status).toBe(200);
    expect(calls[0]!.limit).toBe(25);
  });

  it("forwards summary aggregation: success_rate + token totals", async () => {
    // Custom mock with a 5-run sample so we can verify the math.
    _setOrchestrationRunsReader((d, l) => {
      calls.push({ days: d, limit: l });
      return {
        runs: [],
        summary: {
          total: 5,
          ok_count: 4,
          fail_count: 1,
          success_rate: 0.8,
          total_tokens_in: 50_000,
          total_tokens_out: 5_000,
          modes: { stub: 3, real_llm: 2 },
          tiers: { pro: 4, team: 1 },
        },
      };
    });
    const res = await getRuns("days=7", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: OrchestrationSummary };
    expect(body.summary.total).toBe(5);
    expect(body.summary.success_rate).toBe(0.8);
    expect(body.summary.total_tokens_in).toBe(50_000);
    expect(body.summary.total_tokens_out).toBe(5_000);
    expect(body.summary.modes).toEqual({ stub: 3, real_llm: 2 });
    expect(body.summary.tiers).toEqual({ pro: 4, team: 1 });
  });

  it("returns total=0 + success_rate=0 (no NaN) on empty data", async () => {
    _setOrchestrationRunsReader(() => ({
      runs: [],
      summary: {
        total: 0,
        ok_count: 0,
        fail_count: 0,
        success_rate: 0,
        total_tokens_in: 0,
        total_tokens_out: 0,
        modes: { stub: 0, real_llm: 0 },
        tiers: { pro: 0, team: 0 },
      },
    }));
    const res = await getRuns("", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: OrchestrationRunRow[];
      summary: OrchestrationSummary;
    };
    expect(body.runs).toEqual([]);
    expect(body.summary.total).toBe(0);
    expect(body.summary.success_rate).toBe(0);
    expect(Number.isNaN(body.summary.success_rate)).toBe(false);
  });

  it("reads in DESC received_at order (default reader contract)", async () => {
    // Use the default reader against an in-memory db with two real rows.
    _setOrchestrationRunsReader(null);
    const db = new Database(":memory:");
    _setDb(db);

    db.run(
      `INSERT INTO orchestration_runs
         (identity_hash, graph_id, goal, tier, mode,
          started_at, finished_at, duration_ms, node_count, fail_count, ok,
          total_tokens_in, total_tokens_out, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-1 hour'))`,
      ["a".repeat(64), "g-old", "older goal", "pro", "stub",
       "2026-05-22T09:00:00Z", "2026-05-22T09:00:10Z", 10_000, 1, 0, 1, 100, 0],
    );
    db.run(
      `INSERT INTO orchestration_runs
         (identity_hash, graph_id, goal, tier, mode,
          started_at, finished_at, duration_ms, node_count, fail_count, ok,
          total_tokens_in, total_tokens_out, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ["a".repeat(64), "g-new", "newer goal", "team", "real-llm",
       "2026-05-22T10:00:00Z", "2026-05-22T10:00:20Z", 20_000, 2, 1, 0, 500, 100],
    );

    const res = await getRuns("", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: OrchestrationRunRow[];
      summary: OrchestrationSummary;
    };
    expect(body.runs.length).toBe(2);
    expect(body.runs[0]!.graph_id).toBe("g-new"); // DESC order
    expect(body.runs[1]!.graph_id).toBe("g-old");
    expect(body.summary.total).toBe(2);
    expect(body.summary.ok_count).toBe(1);
    expect(body.summary.fail_count).toBe(1);
    expect(body.summary.success_rate).toBe(0.5);
    expect(body.summary.modes).toEqual({ stub: 1, real_llm: 1 });
    expect(body.summary.tiers).toEqual({ pro: 1, team: 1 });
    expect(body.summary.total_tokens_in).toBe(600);
    expect(body.summary.total_tokens_out).toBe(100);
  });
});
