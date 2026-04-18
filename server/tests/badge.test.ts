import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, createUser, upsertStatsUpload } from "../src/db.js";

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      api_token TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
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
  `);
  return db;
}

describe("badge endpoint", () => {
  let user: ReturnType<typeof createUser>;

  beforeEach(() => {
    _setDb(makeTestDb());
    user = createUser("badge-test@example.com", "test-token-badge-0000000000000000");
    upsertStatsUpload(user.id, 42, 15000, '{"ashlr__read":20}', '{"2025-01-01":5000}');
  });

  afterEach(() => {
    _resetDb();
  });

  it("returns valid SVG for a known user (default pill style)", async () => {
    const res = await app.fetch(new Request(`http://localhost/u/${user.id}/badge.svg`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const body = await res.text();
    expect(body).toContain("<svg");
    expect(body).toContain("</svg>");
    // Should not show "no data yet" — user has data
    expect(body).not.toContain("no data yet");
  });

  it("returns valid SVG with flat style", async () => {
    const res = await app.fetch(
      new Request(`http://localhost/u/${user.id}/badge.svg?metric=calls&style=flat`),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<svg");
  });

  it("returns valid SVG with card style", async () => {
    const res = await app.fetch(
      new Request(`http://localhost/u/${user.id}/badge.svg?metric=dollars&style=card`),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<svg");
  });

  it("returns no-data fallback badge for unknown user id", async () => {
    const res = await app.fetch(
      new Request(`http://localhost/u/nonexistent-user-id/badge.svg`),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("no data yet");
  });
});
