/**
 * orchestration-runs.test.ts — Integration tests for POST /v1/orchestration-runs.
 *
 * Mirrors the session-events.test.ts pattern.
 *
 * Coverage:
 *   1. Valid payload returns 202 and inserts a row with all fields.
 *   2. Optional fields (github_hash, total_tokens_in/out) may be omitted.
 *   3. Validation: identity_hash bad length → 400.
 *   4. Validation: tier outside enum → 400.
 *   5. Validation: mode outside enum → 400.
 *   6. Validation: negative duration_ms → 400.
 *   7. Validation: ok not a boolean → 400.
 *   8. Malformed JSON body → 400.
 *   9. Duplicate POSTs land two rows (we do NOT dedupe — runs are records).
 *  10. Validation: missing required field → 400.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, getDb } from "../src/db.js";

const VALID_IDENTITY = "a".repeat(64);
const VALID_GITHUB   = "b".repeat(64);
const VALID_GRAPH_ID = "g-test-0001-uuid-shape";
const VALID_GOAL     = "refactor auth flow into separate module";
const VALID_STARTED  = "2026-05-22T12:00:00.000Z";
const VALID_FINISHED = "2026-05-22T12:00:42.000Z";

function freshDb(): Database {
  const db = new Database(":memory:");
  _setDb(db);
  return db;
}

async function post(body: unknown): Promise<Response> {
  return await app.fetch(new Request("http://localhost/v1/orchestration-runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identity_hash:    VALID_IDENTITY,
    github_hash:      VALID_GITHUB,
    graph_id:         VALID_GRAPH_ID,
    goal:             VALID_GOAL,
    tier:             "pro",
    mode:             "stub",
    started_at:       VALID_STARTED,
    finished_at:      VALID_FINISHED,
    duration_ms:      42_000,
    node_count:       3,
    fail_count:       0,
    ok:               true,
    total_tokens_in:  12_345,
    total_tokens_out: 0,
    ...overrides,
  };
}

describe("POST /v1/orchestration-runs", () => {
  beforeEach(() => { freshDb(); });
  afterEach(() => { _resetDb(); });

  it("accepts a valid payload and returns 202 with a stored row", async () => {
    const res = await post(validBody());
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const rows = getDb()
      .query<{
        identity_hash: string;
        github_hash: string | null;
        graph_id: string;
        goal: string;
        tier: string;
        mode: string;
        started_at: string;
        finished_at: string;
        duration_ms: number;
        node_count: number;
        fail_count: number;
        ok: number;
        total_tokens_in: number;
        total_tokens_out: number;
      }, []>(
        `SELECT identity_hash, github_hash, graph_id, goal, tier, mode,
                started_at, finished_at, duration_ms, node_count, fail_count,
                ok, total_tokens_in, total_tokens_out
         FROM orchestration_runs`,
      )
      .all();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.identity_hash).toBe(VALID_IDENTITY);
    expect(row.github_hash).toBe(VALID_GITHUB);
    expect(row.graph_id).toBe(VALID_GRAPH_ID);
    expect(row.goal).toBe(VALID_GOAL);
    expect(row.tier).toBe("pro");
    expect(row.mode).toBe("stub");
    expect(row.duration_ms).toBe(42_000);
    expect(row.node_count).toBe(3);
    expect(row.fail_count).toBe(0);
    expect(row.ok).toBe(1);
    expect(row.total_tokens_in).toBe(12_345);
    expect(row.total_tokens_out).toBe(0);
  });

  it("accepts a payload without optional fields (github_hash, token counts)", async () => {
    const res = await post({
      identity_hash: VALID_IDENTITY,
      graph_id:      VALID_GRAPH_ID,
      goal:          VALID_GOAL,
      tier:          "team",
      mode:          "real-llm",
      started_at:    VALID_STARTED,
      finished_at:   VALID_FINISHED,
      duration_ms:   1000,
      node_count:    1,
      fail_count:    0,
      ok:            true,
    });
    expect(res.status).toBe(202);

    const row = getDb()
      .query<{
        github_hash: string | null;
        total_tokens_in: number;
        total_tokens_out: number;
        tier: string;
        mode: string;
      }, []>(
        `SELECT github_hash, total_tokens_in, total_tokens_out, tier, mode
         FROM orchestration_runs LIMIT 1`,
      )
      .get();
    expect(row?.github_hash).toBe(null);
    expect(row?.total_tokens_in).toBe(0);
    expect(row?.total_tokens_out).toBe(0);
    expect(row?.tier).toBe("team");
    expect(row?.mode).toBe("real-llm");
  });

  it("rejects identity_hash with wrong length (400)", async () => {
    const res = await post(validBody({ identity_hash: "a".repeat(40) }));
    expect(res.status).toBe(400);
  });

  it("rejects tier outside enum (400)", async () => {
    const res = await post(validBody({ tier: "free" }));
    expect(res.status).toBe(400);
  });

  it("rejects mode outside enum (400)", async () => {
    const res = await post(validBody({ mode: "real" }));
    expect(res.status).toBe(400);
  });

  it("rejects negative duration_ms (400)", async () => {
    const res = await post(validBody({ duration_ms: -100 }));
    expect(res.status).toBe(400);
  });

  it("rejects non-boolean ok (400)", async () => {
    const res = await post(validBody({ ok: "yes" }));
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON body (400)", async () => {
    const res = await app.fetch(new Request("http://localhost/v1/orchestration-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }));
    expect(res.status).toBe(400);
  });

  it("does NOT dedupe — duplicate POSTs land two rows (runs are records)", async () => {
    const a = await post(validBody());
    const b = await post(validBody());
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);

    const count = getDb()
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM orchestration_runs`)
      .get()!;
    expect(count.n).toBe(2);
  });

  it("rejects missing required field (graph_id) with 400", async () => {
    const body = validBody();
    delete body.graph_id;
    const res = await post(body);
    expect(res.status).toBe(400);
  });

  it("persists ok=false (failure) rows correctly with fail_count > 0", async () => {
    const res = await post(validBody({
      ok: false,
      fail_count: 2,
      node_count: 3,
    }));
    expect(res.status).toBe(202);

    const row = getDb()
      .query<{ ok: number; fail_count: number; node_count: number }, []>(
        `SELECT ok, fail_count, node_count FROM orchestration_runs LIMIT 1`,
      )
      .get();
    expect(row?.ok).toBe(0);
    expect(row?.fail_count).toBe(2);
    expect(row?.node_count).toBe(3);
  });

  it("rejects unknown extra keys via strict() schema (400)", async () => {
    const res = await post(validBody({ extra_evil_field: "boom" }));
    expect(res.status).toBe(400);
  });
});
