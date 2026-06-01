/**
 * public-stats-time-series.test.ts
 *
 * Covers GET /public/stats/time-series:
 *   1. Returns expected shape (no auth needed)
 *   2. Empty DB → empty series
 *   3. Sums tokens per day across users
 *   4. Uses the LATEST upload per user (no multi-sync double-count)
 *   5. Cumulative total is monotonic and correct
 *   6. Dollar conversion ($3/MTok, rounded to cents)
 *   7. Tolerates malformed by_day_json / bad day keys
 *   8. Cache-Control header + cache stability
 *   9. Privacy — no per-user fields leak
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, createUser } from "../src/db.js";
import { _resetPublicTimeSeriesCache } from "../src/db/public-stats.js";

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

function sumValues(byDay: Record<string, number>): number {
  return Object.values(byDay).reduce((a, b) => a + b, 0);
}

function insertUpload(
  db: Database,
  userId: string,
  byDay: Record<string, number>,
  uploadedAt: string,
  byDayRaw?: string,
): void {
  db.run(
    `INSERT INTO stats_uploads
       (id, user_id, uploaded_at, lifetime_tokens_saved, by_tool_json, by_day_json, machine_id)
     VALUES (?, ?, ?, ?, '{}', ?, 'm1')`,
    [
      crypto.randomUUID(),
      userId,
      uploadedAt,
      sumValues(byDay),
      byDayRaw ?? JSON.stringify(byDay),
    ],
  );
}

async function getSeries(): Promise<Response> {
  return app.fetch(new Request("http://localhost/public/stats/time-series"));
}

interface Point {
  date: string;
  tokens_saved: number;
  dollars_saved: number;
  cumulative_tokens_saved: number;
  cumulative_dollars_saved: number;
}

describe("GET /public/stats/time-series", () => {
  let db: Database;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    _resetPublicTimeSeriesCache();
  });

  afterEach(() => {
    _resetDb();
    _resetPublicTimeSeriesCache();
  });

  it("returns 200 with no Authorization header", async () => {
    const res = await getSeries();
    expect(res.status).toBe(200);
  });

  it("returns the expected shape (empty series when no data)", async () => {
    const res = await getSeries();
    const body = (await res.json()) as { series: Point[]; last_updated_at: string };
    expect(Array.isArray(body.series)).toBe(true);
    expect(body.series.length).toBe(0);
    expect(typeof body.last_updated_at).toBe("string");
    expect(new Date(body.last_updated_at).getTime()).not.toBeNaN();
  });

  it("sums tokens per day across users and orders ascending", async () => {
    const u1 = createUser("a@example.com", "token-a-000000000000000000000000000");
    const u2 = createUser("b@example.com", "token-b-000000000000000000000000000");
    insertUpload(db, u1.id, { "2026-01-01": 100, "2026-01-02": 200 }, "2026-01-02T10:00:00Z");
    insertUpload(db, u2.id, { "2026-01-02": 50, "2026-01-03": 70 }, "2026-01-03T10:00:00Z");
    _resetPublicTimeSeriesCache();

    const res = await getSeries();
    const body = (await res.json()) as { series: Point[] };
    expect(body.series.map((p) => p.date)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(body.series.map((p) => p.tokens_saved)).toEqual([100, 250, 70]);
  });

  it("uses the latest upload per user (no multi-sync double-count)", async () => {
    const u = createUser("c@example.com", "token-c-000000000000000000000000000");
    // Older sync had less; newer sync supersedes it entirely.
    insertUpload(db, u.id, { "2026-02-01": 100 }, "2026-02-01T09:00:00Z");
    insertUpload(db, u.id, { "2026-02-01": 300, "2026-02-02": 40 }, "2026-02-02T09:00:00Z");
    _resetPublicTimeSeriesCache();

    const res = await getSeries();
    const body = (await res.json()) as { series: Point[] };
    // Day 02-01 reflects ONLY the latest upload (300), not 100+300=400.
    expect(body.series.find((p) => p.date === "2026-02-01")?.tokens_saved).toBe(300);
    expect(body.series.find((p) => p.date === "2026-02-02")?.tokens_saved).toBe(40);
  });

  it("computes a correct, monotonic cumulative total", async () => {
    const u = createUser("d@example.com", "token-d-000000000000000000000000000");
    insertUpload(
      db,
      u.id,
      { "2026-03-01": 1_000_000, "2026-03-02": 1_000_000, "2026-03-03": 1_000_000 },
      "2026-03-03T10:00:00Z",
    );
    _resetPublicTimeSeriesCache();

    const res = await getSeries();
    const body = (await res.json()) as { series: Point[] };
    expect(body.series.map((p) => p.cumulative_tokens_saved)).toEqual([
      1_000_000, 2_000_000, 3_000_000,
    ]);
    // $3 / 1M tokens → cumulative dollars: 3, 6, 9
    expect(body.series.map((p) => p.cumulative_dollars_saved)).toEqual([3, 6, 9]);
    expect(body.series[0]!.dollars_saved).toBe(3);
  });

  it("tolerates malformed by_day_json and bad day keys", async () => {
    const u1 = createUser("e@example.com", "token-e-000000000000000000000000000");
    const u2 = createUser("f@example.com", "token-f-000000000000000000000000000");
    insertUpload(db, u1.id, {}, "2026-04-01T10:00:00Z", "{ not valid json");
    // Bad/garbage keys and non-positive values are ignored; one good day remains.
    insertUpload(
      db,
      u2.id,
      {},
      "2026-04-02T10:00:00Z",
      JSON.stringify({ "not-a-date": 999, "2026-04-02": 0, "2026-04-03": 500 }),
    );
    _resetPublicTimeSeriesCache();

    const res = await getSeries();
    const body = (await res.json()) as { series: Point[] };
    expect(body.series.map((p) => p.date)).toEqual(["2026-04-03"]);
    expect(body.series[0]!.tokens_saved).toBe(500);
  });

  it("sets Cache-Control: public, max-age=60 and serves a stable cached timestamp", async () => {
    const res1 = await getSeries();
    expect(res1.headers.get("cache-control")).toBe("public, max-age=60");
    const body1 = (await res1.json()) as { last_updated_at: string };
    const res2 = await getSeries();
    const body2 = (await res2.json()) as { last_updated_at: string };
    expect(body1.last_updated_at).toBe(body2.last_updated_at);
  });

  it("never leaks per-user fields", async () => {
    const u = createUser("priv@example.com", "token-priv-0000000000000000000000");
    insertUpload(db, u.id, { "2026-05-01": 10 }, "2026-05-01T10:00:00Z");
    _resetPublicTimeSeriesCache();

    const res = await getSeries();
    const body = (await res.json()) as Record<string, unknown>;
    const FORBIDDEN = ["email", "user_id", "api_token", "machine_id", "github_login"];
    const serialized = JSON.stringify(body);
    for (const key of FORBIDDEN) {
      expect(serialized.includes(key)).toBe(false);
    }
  });
});
