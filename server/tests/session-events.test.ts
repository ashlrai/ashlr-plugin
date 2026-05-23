/**
 * session-events.test.ts — Integration tests for POST /v1/session-events.
 *
 * Q4 session graph capture foundation (the CAPTURE side of the deferred
 * session-graph replay UI). Mirrors the daily-active.test.ts pattern.
 *
 * Coverage:
 *   1. Valid payload returns 202 and inserts a row.
 *   2. Idempotency: same (identity_hash, session_id_hash) yields one row.
 *   3. Optional fields: github_hash, branch_sha, discovery_refs may be omitted.
 *   4. Validation: bad-length identity_hash → 400.
 *   5. Validation: bad-length session_id_hash → 400.
 *   6. Validation: bad ended_at format → 400.
 *   7. Validation: negative tool_count → 400.
 *   8. Malformed JSON → 400.
 *   9. discovery_refs is persisted as JSON array.
 *  10. Cross-session, same-identity: two distinct sessions yield two rows.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, getDb } from "../src/db.js";

const VALID_IDENTITY = "a".repeat(64);
const VALID_GITHUB   = "b".repeat(64);
const VALID_SESSION  = "c".repeat(64);
const VALID_ENDED_AT = "2026-05-22T12:34:56.000Z";
const VALID_VERSION  = "1.31.0";
const VALID_BRANCH   = "abc123def456";

function freshDb(): Database {
  const db = new Database(":memory:");
  _setDb(db);
  return db;
}

async function post(body: unknown): Promise<Response> {
  return await app.fetch(new Request("http://localhost/v1/session-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("POST /v1/session-events", () => {
  beforeEach(() => { freshDb(); });
  afterEach(() => { _resetDb(); });

  it("accepts a valid payload and returns 202 with a stored row", async () => {
    const res = await post({
      identity_hash:    VALID_IDENTITY,
      github_hash:      VALID_GITHUB,
      session_id_hash:  VALID_SESSION,
      ended_at:         VALID_ENDED_AT,
      tool_count:       42,
      tokens_saved:     12_345,
      branch_sha:       VALID_BRANCH,
      discovery_refs:   ["auth-jwt-flow", "rate-limit-buckets"],
      plugin_version:   VALID_VERSION,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const rows = getDb()
      .query<{
        identity_hash: string;
        github_hash: string | null;
        session_id_hash: string;
        ended_at: string;
        tool_count: number;
        tokens_saved: number;
        branch_sha: string | null;
        discovery_refs_json: string;
        plugin_version: string;
      }, []>(
        `SELECT identity_hash, github_hash, session_id_hash, ended_at,
                tool_count, tokens_saved, branch_sha, discovery_refs_json,
                plugin_version
         FROM session_events`,
      )
      .all();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.identity_hash).toBe(VALID_IDENTITY);
    expect(row.github_hash).toBe(VALID_GITHUB);
    expect(row.session_id_hash).toBe(VALID_SESSION);
    expect(row.ended_at).toBe(VALID_ENDED_AT);
    expect(row.tool_count).toBe(42);
    expect(row.tokens_saved).toBe(12_345);
    expect(row.branch_sha).toBe(VALID_BRANCH);
    expect(JSON.parse(row.discovery_refs_json)).toEqual(["auth-jwt-flow", "rate-limit-buckets"]);
    expect(row.plugin_version).toBe(VALID_VERSION);
  });

  it("is idempotent — duplicate (identity_hash, session_id_hash) does not insert twice", async () => {
    const payload = {
      identity_hash:    VALID_IDENTITY,
      session_id_hash:  VALID_SESSION,
      ended_at:         VALID_ENDED_AT,
      tool_count:       5,
      tokens_saved:     100,
      plugin_version:   VALID_VERSION,
    };
    const a = await post(payload);
    const b = await post(payload);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);

    const count = getDb()
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM session_events`)
      .get()!;
    expect(count.n).toBe(1);
  });

  it("accepts a payload without optional fields (github_hash, branch_sha, discovery_refs)", async () => {
    const res = await post({
      identity_hash:    VALID_IDENTITY,
      session_id_hash:  VALID_SESSION,
      ended_at:         VALID_ENDED_AT,
      tool_count:       0,
      tokens_saved:     0,
      plugin_version:   VALID_VERSION,
    });
    expect(res.status).toBe(202);
    const row = getDb()
      .query<{ github_hash: string | null; branch_sha: string | null; discovery_refs_json: string }, []>(
        `SELECT github_hash, branch_sha, discovery_refs_json FROM session_events LIMIT 1`,
      )
      .get();
    expect(row?.github_hash).toBe(null);
    expect(row?.branch_sha).toBe(null);
    expect(JSON.parse(row!.discovery_refs_json)).toEqual([]);
  });

  it("rejects identity_hash with wrong length (400)", async () => {
    const res = await post({
      identity_hash:    "a".repeat(40),
      session_id_hash:  VALID_SESSION,
      ended_at:         VALID_ENDED_AT,
      tool_count:       0,
      tokens_saved:     0,
      plugin_version:   VALID_VERSION,
    });
    expect(res.status).toBe(400);
  });

  it("rejects session_id_hash with wrong length (400)", async () => {
    const res = await post({
      identity_hash:    VALID_IDENTITY,
      session_id_hash:  "c".repeat(30),
      ended_at:         VALID_ENDED_AT,
      tool_count:       0,
      tokens_saved:     0,
      plugin_version:   VALID_VERSION,
    });
    expect(res.status).toBe(400);
  });

  it("rejects badly-formed ended_at (400)", async () => {
    const res = await post({
      identity_hash:    VALID_IDENTITY,
      session_id_hash:  VALID_SESSION,
      ended_at:         "2026/05/22",
      tool_count:       0,
      tokens_saved:     0,
      plugin_version:   VALID_VERSION,
    });
    expect(res.status).toBe(400);
  });

  it("rejects negative tool_count (400)", async () => {
    const res = await post({
      identity_hash:    VALID_IDENTITY,
      session_id_hash:  VALID_SESSION,
      ended_at:         VALID_ENDED_AT,
      tool_count:       -1,
      tokens_saved:     0,
      plugin_version:   VALID_VERSION,
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON body (400)", async () => {
    const res = await app.fetch(new Request("http://localhost/v1/session-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }));
    expect(res.status).toBe(400);
  });

  it("persists discovery_refs as a JSON array preserving order", async () => {
    const refs = ["one", "two", "three", "four"];
    const res = await post({
      identity_hash:    VALID_IDENTITY,
      session_id_hash:  VALID_SESSION,
      ended_at:         VALID_ENDED_AT,
      tool_count:       1,
      tokens_saved:     50,
      discovery_refs:   refs,
      plugin_version:   VALID_VERSION,
    });
    expect(res.status).toBe(202);
    const row = getDb()
      .query<{ discovery_refs_json: string }, []>(
        `SELECT discovery_refs_json FROM session_events LIMIT 1`,
      )
      .get();
    expect(JSON.parse(row!.discovery_refs_json)).toEqual(refs);
  });

  it("two distinct sessions from the same identity yield two rows", async () => {
    const base = {
      identity_hash:    VALID_IDENTITY,
      ended_at:         VALID_ENDED_AT,
      tool_count:       1,
      tokens_saved:     10,
      plugin_version:   VALID_VERSION,
    };
    const a = await post({ ...base, session_id_hash: "1".padEnd(64, "1") });
    const b = await post({ ...base, session_id_hash: "2".padEnd(64, "2") });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const count = getDb()
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM session_events`)
      .get()!;
    expect(count.n).toBe(2);
  });
});
