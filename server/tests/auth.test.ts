import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, createUser, setUserTier } from "../src/db.js";
import { _clearBuckets } from "../src/lib/ratelimit.js";

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
      by_day_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_stats_uploads_user_id ON stats_uploads(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id    ON api_tokens(user_id);
  `);
  return db;
}

describe("auth middleware (GET /stats/aggregate)", () => {
  beforeEach(() => {
    _setDb(makeTestDb());
    _clearBuckets();
  });

  afterEach(() => {
    _resetDb();
    _clearBuckets();
  });

  it("returns 401 when Authorization header is absent", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/aggregate"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization header has wrong scheme", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/aggregate", {
      headers: { "Authorization": "Basic dXNlcjpwYXNz" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when bearer token is not in DB", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/aggregate", {
      headers: { "Authorization": "Bearer not-a-real-token-00000000000000000" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 200 when a valid token is provided", async () => {
    const u = createUser("auth-valid@example.com", "valid-auth-token-00000000000000000");
    setUserTier(u.id, "pro"); // stats/aggregate requires a paid tier
    const res = await app.fetch(new Request("http://localhost/stats/aggregate", {
      headers: { "Authorization": "Bearer valid-auth-token-00000000000000000" },
    }));
    expect(res.status).toBe(200);
  });
});
