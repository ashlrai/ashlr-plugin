/**
 * db.ts — SQLite schema + helpers (Phase 1).
 *
 * Abstraction goal: all SQL lives here. To swap to Postgres in Phase 3,
 * replace this file only — callers depend on the exported function signatures,
 * not on bun:sqlite directly.
 */

import { Database } from "bun:sqlite";
import { join } from "path";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const DB_PATH = process.env["ASHLR_DB_PATH"] ?? join(import.meta.dir, "../../ashlr.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  _db = new Database(DB_PATH, { create: true });
  _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(_db);
  return _db;
}

/** Inject a test database — call before getDb() in tests. */
export function _setDb(db: Database): void {
  _db = db;
}

/** Reset singleton — for tests only. */
export function _resetDb(): void {
  _db = null;
}

// ---------------------------------------------------------------------------
// Migrations (CREATE TABLE IF NOT EXISTS — idempotent on every boot)
// ---------------------------------------------------------------------------

function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      api_token  TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      token        TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stats_uploads (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uploaded_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      lifetime_calls       INTEGER NOT NULL DEFAULT 0,
      lifetime_tokens_saved INTEGER NOT NULL DEFAULT 0,
      by_tool_json         TEXT NOT NULL DEFAULT '{}',
      by_day_json          TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_stats_uploads_user_id ON stats_uploads(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id    ON api_tokens(user_id);
  `);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  api_token: string;
  created_at: string;
}

export interface StatsUpload {
  id: string;
  user_id: string;
  uploaded_at: string;
  lifetime_calls: number;
  lifetime_tokens_saved: number;
  by_tool_json: string;
  by_day_json: string;
}

// ---------------------------------------------------------------------------
// User helpers
// ---------------------------------------------------------------------------

export function createUser(email: string, apiToken: string): User {
  const db = getDb();
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO users (id, email, api_token) VALUES (?, ?, ?)`,
    [id, email, apiToken],
  );
  // Mirror into api_tokens table for lookup
  db.run(
    `INSERT INTO api_tokens (token, user_id) VALUES (?, ?)`,
    [apiToken, id],
  );
  return getUserById(id)!;
}

export function getUserById(id: string): User | null {
  const db = getDb();
  return db.query<User, [string]>(
    `SELECT id, email, api_token, created_at FROM users WHERE id = ?`,
  ).get(id);
}

export function getUserByToken(token: string): User | null {
  const db = getDb();
  const row = db.query<{ user_id: string }, [string]>(
    `SELECT user_id FROM api_tokens WHERE token = ?`,
  ).get(token);
  if (!row) return null;
  // Touch last_used_at
  db.run(
    `UPDATE api_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE token = ?`,
    [token],
  );
  return getUserById(row.user_id);
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

export function upsertStatsUpload(
  userId: string,
  lifetimeCalls: number,
  lifetimeTokensSaved: number,
  byToolJson: string,
  byDayJson: string,
): StatsUpload {
  const db = getDb();
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO stats_uploads
       (id, user_id, lifetime_calls, lifetime_tokens_saved, by_tool_json, by_day_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, lifetimeCalls, lifetimeTokensSaved, byToolJson, byDayJson],
  );
  return getLatestUpload(userId)!;
}

export function getLatestUpload(userId: string): StatsUpload | null {
  const db = getDb();
  return db.query<StatsUpload, [string]>(
    `SELECT * FROM stats_uploads WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT 1`,
  ).get(userId);
}

/**
 * Aggregate all uploads for a user: sum calls, sum tokens, merge by_tool and by_day
 * across every upload row (cross-device aggregate).
 */
export function aggregateUploads(userId: string): {
  lifetime_calls: number;
  lifetime_tokens_saved: number;
  by_tool: Record<string, number>;
  by_day: Record<string, number>;
} {
  const db = getDb();
  const rows = db.query<StatsUpload, [string]>(
    `SELECT * FROM stats_uploads WHERE user_id = ? ORDER BY uploaded_at ASC`,
  ).all(userId);

  let calls = 0;
  let tokens = 0;
  const byTool: Record<string, number> = {};
  const byDay: Record<string, number> = {};

  for (const row of rows) {
    // We keep the max of lifetime fields (they're cumulative per device)
    calls  = Math.max(calls, row.lifetime_calls);
    tokens = Math.max(tokens, row.lifetime_tokens_saved);

    try {
      const tool = JSON.parse(row.by_tool_json) as Record<string, number>;
      for (const [k, v] of Object.entries(tool)) {
        byTool[k] = (byTool[k] ?? 0) + v;
      }
    } catch { /* malformed json — skip */ }

    try {
      const day = JSON.parse(row.by_day_json) as Record<string, number>;
      for (const [k, v] of Object.entries(day)) {
        byDay[k] = (byDay[k] ?? 0) + v;
      }
    } catch { /* malformed json — skip */ }
  }

  return { lifetime_calls: calls, lifetime_tokens_saved: tokens, by_tool: byTool, by_day: byDay };
}
