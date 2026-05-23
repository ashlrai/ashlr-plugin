/**
 * daily-active.test.ts — Integration tests for POST /stats/daily-active.
 *
 * Covers:
 *   1. Valid payload returns 202 and inserts a row.
 *   2. Duplicate payload is idempotent (no second row, no error).
 *   3. Invalid identity_hash (bad length) returns 400.
 *   4. Invalid date format returns 400.
 *   5. github_hash is optional + nullable.
 *   6. Malformed JSON returns 400.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, getDb } from "../src/db.js";

const VALID_IDENTITY = "a".repeat(64);
const VALID_GITHUB   = "b".repeat(64);
const VALID_DATE     = "2026-05-22";
const VALID_VERSION  = "1.30.0";

function freshDb(): Database {
  const db = new Database(":memory:");
  _setDb(db);
  return db;
}

async function post(body: unknown): Promise<Response> {
  return await app.fetch(new Request("http://localhost/stats/daily-active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("POST /stats/daily-active", () => {
  beforeEach(() => { freshDb(); });
  afterEach(() => { _resetDb(); });

  it("accepts a valid payload and returns 202 with a stored row", async () => {
    const res = await post({
      identity_hash:  VALID_IDENTITY,
      github_hash:    VALID_GITHUB,
      date:           VALID_DATE,
      plugin_version: VALID_VERSION,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const rows = getDb()
      .query<{ identity_hash: string; github_hash: string | null; active_date: string; plugin_version: string }, []>(
        `SELECT identity_hash, github_hash, active_date, plugin_version FROM daily_active_records`,
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.identity_hash).toBe(VALID_IDENTITY);
    expect(rows[0]!.github_hash).toBe(VALID_GITHUB);
    expect(rows[0]!.active_date).toBe(VALID_DATE);
    expect(rows[0]!.plugin_version).toBe(VALID_VERSION);
  });

  it("is idempotent — duplicate payload does not error or insert a second row", async () => {
    const payload = {
      identity_hash:  VALID_IDENTITY,
      github_hash:    null,
      date:           VALID_DATE,
      plugin_version: VALID_VERSION,
    };
    const a = await post(payload);
    const b = await post(payload);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);

    const count = getDb()
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM daily_active_records`)
      .get()!;
    expect(count.n).toBe(1);
  });

  it("accepts a payload without github_hash (optional + nullable)", async () => {
    const res = await post({
      identity_hash:  VALID_IDENTITY,
      date:           VALID_DATE,
      plugin_version: VALID_VERSION,
    });
    expect(res.status).toBe(202);
    const row = getDb()
      .query<{ github_hash: string | null }, []>(
        `SELECT github_hash FROM daily_active_records LIMIT 1`,
      )
      .get();
    expect(row?.github_hash).toBe(null);
  });

  it("rejects identity_hash with wrong length (400)", async () => {
    const res = await post({
      identity_hash:  "a".repeat(40), // too short
      date:           VALID_DATE,
      plugin_version: VALID_VERSION,
    });
    expect(res.status).toBe(400);
  });

  it("rejects identity_hash with non-hex characters (400)", async () => {
    const res = await post({
      identity_hash:  "g".repeat(64), // 'g' not hex
      date:           VALID_DATE,
      plugin_version: VALID_VERSION,
    });
    expect(res.status).toBe(400);
  });

  it("rejects badly-formed date (400)", async () => {
    const res = await post({
      identity_hash:  VALID_IDENTITY,
      date:           "2026/05/22", // wrong separator
      plugin_version: VALID_VERSION,
    });
    expect(res.status).toBe(400);
  });

  it("rejects github_hash with wrong length (400) when present", async () => {
    const res = await post({
      identity_hash:  VALID_IDENTITY,
      github_hash:    "b".repeat(30),
      date:           VALID_DATE,
      plugin_version: VALID_VERSION,
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON body (400)", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/daily-active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }));
    expect(res.status).toBe(400);
  });
});
