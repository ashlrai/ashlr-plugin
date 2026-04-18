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
  addTierColumnIfMissing(_db);
  return _db;
}

/** Inject a test database — call before getDb() in tests. Runs migrations immediately. */
export function _setDb(db: Database): void {
  _db = db;
  runMigrations(db);
  addTierColumnIfMissing(db);
}

/** Reset singleton — for tests only. */
export function _resetDb(): void {
  _db = null;
}

// ---------------------------------------------------------------------------
// Migrations (CREATE TABLE IF NOT EXISTS — idempotent on every boot)
// ---------------------------------------------------------------------------

function addTierColumnIfMissing(db: Database): void {
  // SQLite has no ALTER TABLE ADD COLUMN IF NOT EXISTS — inspect pragma instead.
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(users)`).all();
  if (!cols.some((c) => c.name === "tier")) {
    db.exec(`ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'`);
  }
}

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

    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date       TEXT NOT NULL,  -- ISO date "YYYY-MM-DD"
      summarize_calls INTEGER NOT NULL DEFAULT 0,
      total_cost REAL    NOT NULL DEFAULT 0.0,
      PRIMARY KEY (user_id, date)
    );

    CREATE TABLE IF NOT EXISTS llm_calls (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      tool_name    TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost         REAL    NOT NULL DEFAULT 0.0,
      cached       INTEGER NOT NULL DEFAULT 0  -- 0=false, 1=true (SQLite boolean)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_usage(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_user_at     ON llm_calls(user_id, at);

    -- Phase 3: Stripe billing tables
    -- users.tier column added below via addTierColumnIfMissing() (ALTER TABLE is not idempotent in SQLite).

    CREATE TABLE IF NOT EXISTS subscriptions (
      id                     TEXT PRIMARY KEY,
      user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stripe_subscription_id TEXT NOT NULL UNIQUE,
      stripe_customer_id     TEXT NOT NULL,
      tier                   TEXT NOT NULL DEFAULT 'pro',
      status                 TEXT NOT NULL DEFAULT 'active',
      seats                  INTEGER NOT NULL DEFAULT 1,
      created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      current_period_end     TEXT,
      cancel_at              TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub_id ON subscriptions(stripe_subscription_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_cust_id ON subscriptions(stripe_customer_id);

    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id     TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS stripe_products (
      key        TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      price_id   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
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
  tier: string; // "free" | "pro" | "team"
}

// ---------------------------------------------------------------------------
// Billing types
// ---------------------------------------------------------------------------

export interface Subscription {
  id: string;
  user_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  tier: string;
  status: string;
  seats: number;
  created_at: string;
  current_period_end: string | null;
  cancel_at: string | null;
}

export interface StripeProduct {
  key: string;
  product_id: string;
  price_id: string;
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
// Types
// ---------------------------------------------------------------------------

export interface DailyUsage {
  user_id: string;
  date: string;
  summarize_calls: number;
  total_cost: number;
}

export interface LlmCall {
  id: string;
  user_id: string;
  at: string;
  tool_name: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  cached: number; // 0 or 1
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
    `SELECT id, email, api_token, created_at, tier FROM users WHERE id = ?`,
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

// ---------------------------------------------------------------------------
// Daily usage + cap helpers (Phase 2 — LLM summarizer)
// ---------------------------------------------------------------------------

const DAILY_CAP_CALLS = 1000;
const DAILY_CAP_COST  = 1.00; // $1.00 USD

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export function bumpDailyUsage(userId: string, cost: number): void {
  const db   = getDb();
  const date = todayUTC();
  db.run(
    `INSERT INTO daily_usage (user_id, date, summarize_calls, total_cost)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       summarize_calls = summarize_calls + 1,
       total_cost      = total_cost + excluded.total_cost`,
    [userId, date, cost],
  );
}

export function checkDailyCap(userId: string): { allowed: boolean; remaining: { calls: number; cost: number } } {
  const db   = getDb();
  const date = todayUTC();
  const row  = db.query<DailyUsage, [string, string]>(
    `SELECT * FROM daily_usage WHERE user_id = ? AND date = ?`,
  ).get(userId, date);

  const calls     = row?.summarize_calls ?? 0;
  const cost      = row?.total_cost      ?? 0;
  const callsLeft = DAILY_CAP_CALLS - calls;
  const costLeft  = DAILY_CAP_COST  - cost;
  const allowed   = callsLeft > 0 && costLeft > 0;

  return { allowed, remaining: { calls: callsLeft, cost: Math.max(0, costLeft) } };
}

export function getDailyUsage(userId: string, date?: string): DailyUsage | null {
  const db  = getDb();
  const day = date ?? todayUTC();
  return db.query<DailyUsage, [string, string]>(
    `SELECT * FROM daily_usage WHERE user_id = ? AND date = ?`,
  ).get(userId, day);
}

// ---------------------------------------------------------------------------
// LLM call log (Phase 2)
// ---------------------------------------------------------------------------

export interface LogLlmCallParams {
  userId: string;
  toolName: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  cached: boolean;
}

export function logLlmCall(params: LogLlmCallParams): void {
  const db = getDb();
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO llm_calls (id, user_id, tool_name, input_tokens, output_tokens, cost, cached)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.userId,
      params.toolName,
      params.inputTokens,
      params.outputTokens,
      params.cost,
      params.cached ? 1 : 0,
    ],
  );
}

export function getLlmCallsForUser(userId: string, limit = 100): LlmCall[] {
  const db = getDb();
  return db.query<LlmCall, [string, number]>(
    `SELECT * FROM llm_calls WHERE user_id = ? ORDER BY at DESC LIMIT ?`,
  ).all(userId, limit);
}

// ---------------------------------------------------------------------------
// Billing helpers (Phase 3)
// ---------------------------------------------------------------------------

export function setUserTier(userId: string, tier: string): void {
  getDb().run(`UPDATE users SET tier = ? WHERE id = ?`, [tier, userId]);
}

export function getSubscriptionByUserId(userId: string): Subscription | null {
  return getDb()
    .query<Subscription, [string]>(
      `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId);
}

export function getSubscriptionByStripeSubId(stripeSubId: string): Subscription | null {
  return getDb()
    .query<Subscription, [string]>(
      `SELECT * FROM subscriptions WHERE stripe_subscription_id = ?`,
    )
    .get(stripeSubId);
}

export function getSubscriptionByStripeCustomerId(customerId: string): Subscription | null {
  return getDb()
    .query<Subscription, [string]>(
      `SELECT * FROM subscriptions WHERE stripe_customer_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(customerId);
}

export function upsertSubscription(params: {
  userId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  tier: string;
  status: string;
  seats: number;
  currentPeriodEnd: string | null;
  cancelAt: string | null;
}): void {
  const db = getDb();
  const existing = getSubscriptionByStripeSubId(params.stripeSubscriptionId);
  if (existing) {
    db.run(
      `UPDATE subscriptions SET
         tier = ?, status = ?, seats = ?, current_period_end = ?, cancel_at = ?
       WHERE stripe_subscription_id = ?`,
      [
        params.tier,
        params.status,
        params.seats,
        params.currentPeriodEnd,
        params.cancelAt,
        params.stripeSubscriptionId,
      ],
    );
  } else {
    db.run(
      `INSERT INTO subscriptions
         (id, user_id, stripe_subscription_id, stripe_customer_id, tier, status, seats, current_period_end, cancel_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        params.userId,
        params.stripeSubscriptionId,
        params.stripeCustomerId,
        params.tier,
        params.status,
        params.seats,
        params.currentPeriodEnd,
        params.cancelAt,
      ],
    );
  }
}

export function isStripeEventProcessed(eventId: string): boolean {
  const row = getDb()
    .query<{ event_id: string }, [string]>(
      `SELECT event_id FROM stripe_events WHERE event_id = ?`,
    )
    .get(eventId);
  return row !== null;
}

export function markStripeEventProcessed(eventId: string): void {
  getDb().run(
    `INSERT OR IGNORE INTO stripe_events (event_id) VALUES (?)`,
    [eventId],
  );
}

export function getStripeProduct(key: string): StripeProduct | null {
  return getDb()
    .query<StripeProduct, [string]>(
      `SELECT * FROM stripe_products WHERE key = ?`,
    )
    .get(key);
}

export function upsertStripeProduct(key: string, productId: string, priceId: string): void {
  getDb().run(
    `INSERT INTO stripe_products (key, product_id, price_id)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET product_id = excluded.product_id, price_id = excluded.price_id`,
    [key, productId, priceId],
  );
}

export function getUserByStripeCustomerId(customerId: string): User | null {
  const sub = getSubscriptionByStripeCustomerId(customerId);
  if (!sub) return null;
  return getUserById(sub.user_id);
}
