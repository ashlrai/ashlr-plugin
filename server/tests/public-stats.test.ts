/**
 * public-stats.test.ts
 *
 * Covers:
 *   1. GET /public/stats returns expected shape (no auth needed)
 *   2. Aggregate maths (SUM of max per user, dollar conversion)
 *   3. Cache TTL — second call hits cache, not DB
 *   4. Privacy guarantee — response never contains per-user fields
 *   5. Cache-Control header is set correctly
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, createUser } from "../src/db.js";
import { _resetPublicStatsCache } from "../src/db/public-stats.js";

// ---------------------------------------------------------------------------
// Minimal schema (same subset as stats.test.ts)
// ---------------------------------------------------------------------------

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      api_token TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      tier TEXT NOT NULL DEFAULT 'free'
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS stats_uploads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      lifetime_calls INTEGER NOT NULL DEFAULT 0,
      lifetime_tokens_saved INTEGER NOT NULL DEFAULT 0,
      by_tool_json TEXT NOT NULL DEFAULT '{}',
      by_day_json TEXT NOT NULL DEFAULT '{}',
      machine_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stats_uploads_user_id ON stats_uploads(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id    ON api_tokens(user_id);
  `);
  return db;
}

function insertUpload(
  db: Database,
  userId: string,
  tokensSaved: number,
  machineId = "m1",
): void {
  db.run(
    `INSERT INTO stats_uploads
       (id, user_id, lifetime_tokens_saved, by_tool_json, by_day_json, machine_id)
     VALUES (?, ?, ?, '{}', '{}', ?)`,
    [crypto.randomUUID(), userId, tokensSaved, machineId],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getStats(): Promise<Response> {
  return app.fetch(new Request("http://localhost/public/stats"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /public/stats", () => {
  let db: Database;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    _resetPublicStatsCache();
  });

  afterEach(() => {
    _resetDb();
    _resetPublicStatsCache();
  });

  it("returns 200 with no Authorization header", async () => {
    const res = await getStats();
    expect(res.status).toBe(200);
  });

  it("returns the expected shape", async () => {
    const res = await getStats();
    const body = await res.json() as Record<string, unknown>;

    expect(typeof body["total_tokens_saved_lifetime"]).toBe("number");
    expect(typeof body["total_users"]).toBe("number");
    expect(typeof body["total_dollars_saved"]).toBe("number");
    expect(typeof body["last_updated_at"]).toBe("string");
    // last_updated_at must be a valid ISO 8601 string
    expect(new Date(body["last_updated_at"] as string).getTime()).not.toBeNaN();
  });

  it("returns zeros when no data exists", async () => {
    const res = await getStats();
    const body = await res.json() as Record<string, number>;

    expect(body["total_tokens_saved_lifetime"]).toBe(0);
    expect(body["total_users"]).toBe(0);
    expect(body["total_dollars_saved"]).toBe(0);
  });

  it("counts total_users correctly", async () => {
    createUser("a@example.com", "token-a-000000000000000000000000000");
    createUser("b@example.com", "token-b-000000000000000000000000000");
    _resetPublicStatsCache();

    const res = await getStats();
    const body = await res.json() as { total_users: number };
    expect(body.total_users).toBe(2);
  });

  it("sums the max tokens per user (avoids multi-machine double-counting)", async () => {
    // user1: two uploads from different machines (100K and 80K — take max = 100K)
    const u1 = createUser("u1@example.com", "token-u1-00000000000000000000000");
    insertUpload(db, u1.id, 100_000, "machine-A");
    insertUpload(db, u1.id,  80_000, "machine-B");

    // user2: one upload (50K)
    const u2 = createUser("u2@example.com", "token-u2-00000000000000000000000");
    insertUpload(db, u2.id, 50_000, "machine-C");

    _resetPublicStatsCache();

    const res = await getStats();
    const body = await res.json() as { total_tokens_saved_lifetime: number };
    // 100K (max for u1) + 50K (u2) = 150K
    expect(body.total_tokens_saved_lifetime).toBe(150_000);
  });

  it("computes total_dollars_saved as tokens * (3.0 / 1_000_000), rounded to cents", async () => {
    const u = createUser("d@example.com", "token-d-000000000000000000000000");
    insertUpload(db, u.id, 1_000_000);
    _resetPublicStatsCache();

    const res = await getStats();
    const body = await res.json() as { total_dollars_saved: number };
    // 1_000_000 tokens * $3 / 1M = $3.00
    expect(body.total_dollars_saved).toBe(3.00);
  });

  it("sets Cache-Control: public, max-age=60 header", async () => {
    const res = await getStats();
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("serves cached data on second call (last_updated_at is stable)", async () => {
    const res1 = await getStats();
    const body1 = await res1.json() as { last_updated_at: string };

    const res2 = await getStats();
    const body2 = await res2.json() as { last_updated_at: string };

    // Both calls return the same timestamp — second hit is from cache
    expect(body1.last_updated_at).toBe(body2.last_updated_at);
  });

  // -------------------------------------------------------------------------
  // Privacy guarantee
  // -------------------------------------------------------------------------

  it("does not expose any per-user fields", async () => {
    createUser("priv@example.com", "token-priv-0000000000000000000000");
    _resetPublicStatsCache();

    const res = await getStats();
    const body = await res.json() as Record<string, unknown>;

    const FORBIDDEN_KEYS = [
      "email", "user_id", "api_token", "id", "session",
      "machine_id", "by_tool", "by_day", "lifetime_calls",
    ];
    for (const key of FORBIDDEN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(body, key)).toBe(false);
    }
  });

  it("does not expose a list of users or emails", async () => {
    createUser("list@example.com", "token-list-000000000000000000000");
    _resetPublicStatsCache();

    const res = await getStats();
    const body = await res.json() as Record<string, unknown>;

    // No array values at the top level
    for (const val of Object.values(body)) {
      expect(Array.isArray(val)).toBe(false);
    }
  });
});
