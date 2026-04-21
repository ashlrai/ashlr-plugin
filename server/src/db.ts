/**
 * db.ts — SQLite schema + helpers (Phase 1).
 *
 * Abstraction goal: all SQL lives here. To swap to Postgres in Phase 3,
 * replace this file only — callers depend on the exported function signatures,
 * not on bun:sqlite directly.
 */

import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
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
  if (!cols.some((c) => c.name === "org_id")) {
    db.exec(`ALTER TABLE users ADD COLUMN org_id TEXT`);
  }
  if (!cols.some((c) => c.name === "org_role")) {
    db.exec(`ALTER TABLE users ADD COLUMN org_role TEXT`);
  }
  if (!cols.some((c) => c.name === "is_admin")) {
    db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.some((c) => c.name === "comp_expires_at")) {
    db.exec(`ALTER TABLE users ADD COLUMN comp_expires_at TEXT`);
  }
  // v2 encryption columns — added as late migrations so existing DBs stay compatible
  const sectionCols = db.query<{ name: string }, []>(`PRAGMA table_info(genome_sections)`).all();
  if (!sectionCols.some((c) => c.name === "content_encrypted")) {
    db.exec(`ALTER TABLE genome_sections ADD COLUMN content_encrypted INTEGER NOT NULL DEFAULT 0`);
  }
  const genomeCols = db.query<{ name: string }, []>(`PRAGMA table_info(genomes)`).all();
  if (!genomeCols.some((c) => c.name === "encryption_required")) {
    db.exec(`ALTER TABLE genomes ADD COLUMN encryption_required INTEGER NOT NULL DEFAULT 0`);
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

    -- Phase 4: Magic-link auth
    CREATE TABLE IF NOT EXISTS magic_tokens (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      expires_at TEXT NOT NULL,
      used_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_magic_tokens_email ON magic_tokens(email);

    -- Upgrade-flow: one-time pickup table for terminal sign-in polling
    CREATE TABLE IF NOT EXISTS pending_auth_tokens (
      email      TEXT PRIMARY KEY,
      api_token  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    -- Phase 3 (genome): team CRDT genome sync
    CREATE TABLE IF NOT EXISTS genomes (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      repo_url   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      server_seq INTEGER NOT NULL DEFAULT 0,
      UNIQUE(org_id, repo_url)
    );

    CREATE TABLE IF NOT EXISTS genome_sections (
      id            TEXT PRIMARY KEY,
      genome_id     TEXT NOT NULL REFERENCES genomes(id) ON DELETE CASCADE,
      path          TEXT NOT NULL,
      content       TEXT NOT NULL DEFAULT '',
      vclock_json   TEXT NOT NULL DEFAULT '{}',
      conflict_flag INTEGER NOT NULL DEFAULT 0,
      server_seq    INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      UNIQUE(genome_id, path)
    );

    CREATE INDEX IF NOT EXISTS idx_genome_sections_genome_seq ON genome_sections(genome_id, server_seq);

    CREATE TABLE IF NOT EXISTS genome_conflicts (
      id           TEXT PRIMARY KEY,
      genome_id    TEXT NOT NULL REFERENCES genomes(id) ON DELETE CASCADE,
      path         TEXT NOT NULL,
      variants_json TEXT NOT NULL DEFAULT '[]',
      detected_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_genome_conflicts_genome ON genome_conflicts(genome_id);

    CREATE TABLE IF NOT EXISTS genome_push_log (
      id         TEXT PRIMARY KEY,
      genome_id  TEXT NOT NULL,
      client_id  TEXT NOT NULL,
      path       TEXT NOT NULL,
      at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_genome_push_log_genome ON genome_push_log(genome_id, at);

    -- Phase 4: Policy packs
    CREATE TABLE IF NOT EXISTS policy_packs (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      name       TEXT NOT NULL,
      version    INTEGER NOT NULL DEFAULT 1,
      rules_json TEXT NOT NULL DEFAULT '{"allow":[],"deny":[],"requireConfirm":[]}',
      author     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      UNIQUE (org_id, name, version)
    );

    CREATE TABLE IF NOT EXISTS policy_current (
      org_id  TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      set_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_policy_packs_org ON policy_packs(org_id);

    -- Phase 4: Audit log (append-only; no UPDATE/DELETE except admin purge)
    CREATE TABLE IF NOT EXISTS audit_events (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      tool            TEXT NOT NULL,
      args_json       TEXT NOT NULL DEFAULT '{}',
      cwd_fingerprint TEXT NOT NULL DEFAULT '',
      git_commit      TEXT NOT NULL DEFAULT '',
      at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_org_at   ON audit_events(org_id, at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_user_at  ON audit_events(user_id, at);

    -- Email: daily cap notification throttle (one email per user per UTC date)
    CREATE TABLE IF NOT EXISTS daily_cap_notifications (
      user_id TEXT NOT NULL,
      date    TEXT NOT NULL,  -- ISO date "YYYY-MM-DD"
      PRIMARY KEY (user_id, date)
    );

    -- Status page: synthetic health checks
    CREATE TABLE IF NOT EXISTS health_checks (
      id          TEXT PRIMARY KEY,
      component   TEXT NOT NULL,
      status      TEXT NOT NULL,  -- 'ok' | 'degraded' | 'down'
      latency_ms  INTEGER,
      checked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      error_text  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_health_checks_component_at ON health_checks(component, checked_at);

    -- Status page: incidents
    CREATE TABLE IF NOT EXISTS incidents (
      id                       TEXT PRIMARY KEY,
      title                    TEXT NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'investigating',
      affected_components_json TEXT NOT NULL DEFAULT '[]',
      created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      resolved_at              TEXT,
      body                     TEXT NOT NULL DEFAULT ''
    );

    -- Status page: incident timeline updates
    CREATE TABLE IF NOT EXISTS incident_updates (
      id          TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      status      TEXT NOT NULL,
      body        TEXT NOT NULL,
      posted_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id, posted_at);

    -- Status page: email subscribers
    CREATE TABLE IF NOT EXISTS status_subscribers (
      email             TEXT PRIMARY KEY,
      confirmed_at      TEXT,
      confirm_token     TEXT NOT NULL,
      confirm_expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_status_subscribers_token ON status_subscribers(confirm_token);

    -- Teams: a user on the team tier can create a team and invite members.
    -- A user belongs to at most one team (enforced at the application layer,
    -- not in the schema — simpler to change later).
    CREATE TABLE IF NOT EXISTS teams (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id    TEXT NOT NULL REFERENCES teams(id),
      user_id    TEXT NOT NULL REFERENCES users(id),
      role       TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      joined_at  TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

    CREATE TABLE IF NOT EXISTS team_invites (
      token         TEXT PRIMARY KEY,
      team_id       TEXT NOT NULL REFERENCES teams(id),
      email         TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      invited_by    TEXT NOT NULL REFERENCES users(id),
      expires_at    TEXT NOT NULL,
      accepted_at   TEXT,
      revoked_at    TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_team_invites_team  ON team_invites(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_invites_email ON team_invites(email);
  `);
}

// ---------------------------------------------------------------------------
// Daily cap notification helpers
// ---------------------------------------------------------------------------

/**
 * Returns true and records the notification if this is the first cap-reached
 * event for this user today (UTC).  Returns false if already sent today.
 */
export function tryRecordDailyCapNotification(userId: string): boolean {
  const date = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const db = getDb();
  try {
    db.run(
      `INSERT INTO daily_cap_notifications (user_id, date) VALUES (?, ?)`,
      [userId, date],
    );
    return true;
  } catch {
    // UNIQUE constraint violation — already sent today
    return false;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  api_token: string;
  created_at: string;
  tier: string;           // "free" | "pro" | "team"
  org_id: string | null;
  org_role: string | null; // "admin" | "member" | null
  is_admin: number;        // 0 | 1 (SQLite boolean)
  comp_expires_at: string | null;
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
    `SELECT id, email, api_token, created_at, tier, org_id, org_role, is_admin, comp_expires_at FROM users WHERE id = ?`,
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

/**
 * True when the user has never had any subscription record (trial, paid, or
 * canceled). Used by the checkout flow to gate the 7-day trial — users who
 * previously trialed or subscribed don't get another trial on subsequent
 * checkouts. A single-row lookup via idx_subscriptions_user_id.
 */
export function userIsTrialEligible(userId: string): boolean {
  const row = getDb()
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?`,
    )
    .get(userId);
  return (row?.n ?? 0) === 0;
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

/**
 * Atomically claim an event for processing.
 * Returns true if this caller is the first to process this event_id (inserted),
 * false if another delivery already claimed it (conflict = duplicate).
 * Uses INSERT … ON CONFLICT DO NOTHING so the check+write is a single
 * SQLite statement — no TOCTOU window.
 */
export function tryMarkStripeEventProcessed(eventId: string): boolean {
  const result = getDb().run(
    `INSERT INTO stripe_events (event_id) VALUES (?) ON CONFLICT (event_id) DO NOTHING`,
    [eventId],
  );
  return result.changes === 1;
}

/**
 * Remove a stripe_events row so a failed delivery can be retried.
 * Called when the webhook handler throws after tryMarkStripeEventProcessed
 * already claimed the event.
 */
export function deleteStripeEvent(eventId: string): void {
  getDb().run(`DELETE FROM stripe_events WHERE event_id = ?`, [eventId]);
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

// ---------------------------------------------------------------------------
// Magic-link auth helpers (Phase 4)
// ---------------------------------------------------------------------------

export interface MagicToken {
  token: string;
  email: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export function createMagicToken(email: string, token: string, expiresAt: string): void {
  getDb().run(
    `INSERT INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)`,
    [token, email, expiresAt],
  );
}

export function getMagicToken(token: string): MagicToken | null {
  return getDb()
    .query<MagicToken, [string]>(`SELECT * FROM magic_tokens WHERE token = ?`)
    .get(token);
}

export function markMagicTokenUsed(token: string): void {
  getDb().run(
    `UPDATE magic_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE token = ?`,
    [token],
  );
}

/** Count magic tokens created for an email within the last windowMs milliseconds. */
export function countRecentMagicTokens(email: string, windowMs: number): number {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = getDb()
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM magic_tokens WHERE email = ? AND created_at >= ?`,
    )
    .get(email, since);
  return row?.n ?? 0;
}

/** Create a user if one does not exist for this email. Returns the user either way. */
export function getOrCreateUserByEmail(email: string): User {
  const db = getDb();
  const existing = db.query<User, [string]>(
    `SELECT id, email, api_token, created_at, tier, org_id, org_role, is_admin, comp_expires_at FROM users WHERE email = ?`,
  ).get(email);
  if (existing) return existing;
  // Placeholder api_token — will be replaced when they verify the magic link.
  const placeholder = crypto.randomUUID();
  return createUser(email, placeholder);
}

/** Issue a fresh API token for a user (inserts into api_tokens, returns the token string). */
export function issueApiToken(userId: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  getDb().run(
    `INSERT INTO api_tokens (token, user_id) VALUES (?, ?)`,
    [token, userId],
  );
  return token;
}

// ---------------------------------------------------------------------------
// Upgrade-flow: pending_auth_tokens helpers
// ---------------------------------------------------------------------------

/**
 * Store an API token for pickup by the terminal upgrade-flow poller.
 * Called from POST /auth/verify after a magic link is clicked in the browser.
 * The row is keyed by email; only one pending token per email is kept.
 */
export function storePendingAuthToken(email: string, apiToken: string): void {
  getDb().run(
    `INSERT OR REPLACE INTO pending_auth_tokens (email, api_token) VALUES (?, ?)`,
    [email, apiToken],
  );
}

/**
 * Atomically retrieve and delete the pending token for an email.
 * Returns { apiToken } once (single-use), or null if none is pending.
 * Rows older than 3 minutes are treated as expired.
 *
 * Wraps SELECT + DELETE in a transaction so two concurrent polls for the
 * same email cannot both receive the same live token.
 */
export function consumeVerifiedTokenForEmail(email: string): { apiToken: string } | null {
  const db = getDb();
  const cutoff = new Date(Date.now() - 3 * 60 * 1_000).toISOString();
  const txn = db.transaction(() => {
    const row = db
      .query<{ api_token: string }, [string, string]>(
        `SELECT api_token FROM pending_auth_tokens WHERE email = ? AND created_at >= ?`,
      )
      .get(email, cutoff);
    if (!row) return null;
    db.run(`DELETE FROM pending_auth_tokens WHERE email = ?`, [email]);
    return { apiToken: row.api_token };
  });
  return txn();
}

/**
 * Non-consuming peek — used in tests to confirm a token was stored.
 * Not used by production code paths.
 */
export function getVerifiedTokenForEmail(email: string): { apiToken: string } | null {
  const cutoff = new Date(Date.now() - 3 * 60 * 1_000).toISOString();
  const row = getDb()
    .query<{ api_token: string }, [string, string]>(
      `SELECT api_token FROM pending_auth_tokens WHERE email = ? AND created_at >= ?`,
    )
    .get(email, cutoff);
  return row ? { apiToken: row.api_token } : null;
}

// ---------------------------------------------------------------------------
// Genome helpers (Phase 3 — team CRDT genome sync)
// ---------------------------------------------------------------------------

export interface Genome {
  id: string;
  org_id: string;
  repo_url: string;
  created_at: string;
  server_seq: number;
  encryption_required: number; // 0 = false, 1 = true
}

export interface GenomeSection {
  id: string;
  genome_id: string;
  path: string;
  content: string;
  vclock_json: string;
  conflict_flag: number;
  content_encrypted: number; // 0 = plaintext, 1 = AES-256-GCM ciphertext blob
  server_seq: number;
  updated_at: string;
}

export interface GenomeConflict {
  id: string;
  genome_id: string;
  path: string;
  variants_json: string;
  detected_at: string;
}

/** Create or return an existing genome for (orgId, repoUrl). Returns {genome, created}. */
export function upsertGenome(orgId: string, repoUrl: string): { genome: Genome; created: boolean } {
  const db = getDb();
  const existing = db.query<Genome, [string, string]>(
    `SELECT id, org_id, repo_url, created_at, server_seq FROM genomes WHERE org_id = ? AND repo_url = ?`,
  ).get(orgId, repoUrl);
  if (existing) return { genome: existing, created: false };

  const id = crypto.randomUUID();
  db.run(`INSERT INTO genomes (id, org_id, repo_url) VALUES (?, ?, ?)`, [id, orgId, repoUrl]);
  return { genome: db.query<Genome, [string]>(`SELECT * FROM genomes WHERE id = ?`).get(id)!, created: true };
}

export function getGenomeById(id: string): Genome | null {
  return getDb().query<Genome, [string]>(`SELECT * FROM genomes WHERE id = ?`).get(id);
}

/**
 * Load a genome only if it belongs to the given team.
 * Returns null when the genome doesn't exist OR the team doesn't own it —
 * callers should always respond 404 so existence isn't leaked to unauthorized callers.
 *
 * Safety invariant: `teamId` must be a non-empty string. Post-v1.11.1 rows
 * always have `org_id = <real team id>` because `/genome/init` sources it
 * from `getTeamForUser`. Pre-v1.11.1 rows may carry an empty or attacker-
 * supplied `org_id` — we reject empty `teamId` explicitly so a future caller
 * that defaults to `?? ""` can't reach the query and accidentally match a
 * legacy blank-org row.
 */
export function requireGenomeAccess(id: string, teamId: string): Genome | null {
  if (!teamId) return null;
  const g = getDb()
    .query<Genome, [string, string]>(`SELECT * FROM genomes WHERE id = ? AND org_id = ?`)
    .get(id, teamId);
  return g ?? null;
}

export function deleteGenome(id: string): void {
  getDb().run(`DELETE FROM genomes WHERE id = ?`, [id]);
}

/** Atomically bump server_seq on genome and return the new value. */
export function bumpGenomeSeq(genomeId: string): number {
  const db = getDb();
  db.run(`UPDATE genomes SET server_seq = server_seq + 1 WHERE id = ?`, [genomeId]);
  const row = db.query<{ server_seq: number }, [string]>(
    `SELECT server_seq FROM genomes WHERE id = ?`,
  ).get(genomeId);
  return row!.server_seq;
}

/** Upsert a genome section. Returns the stored section. */
export function upsertGenomeSection(
  genomeId: string,
  path: string,
  content: string,
  vclockJson: string,
  conflictFlag: boolean,
  serverSeq: number,
  contentEncrypted = false,
): GenomeSection {
  const db = getDb();
  const existing = db.query<GenomeSection, [string, string]>(
    `SELECT * FROM genome_sections WHERE genome_id = ? AND path = ?`,
  ).get(genomeId, path);

  if (existing) {
    db.run(
      `UPDATE genome_sections SET content = ?, vclock_json = ?, conflict_flag = ?, content_encrypted = ?, server_seq = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE genome_id = ? AND path = ?`,
      [content, vclockJson, conflictFlag ? 1 : 0, contentEncrypted ? 1 : 0, serverSeq, genomeId, path],
    );
  } else {
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO genome_sections (id, genome_id, path, content, vclock_json, conflict_flag, content_encrypted, server_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, genomeId, path, content, vclockJson, conflictFlag ? 1 : 0, contentEncrypted ? 1 : 0, serverSeq],
    );
  }

  return db.query<GenomeSection, [string, string]>(
    `SELECT * FROM genome_sections WHERE genome_id = ? AND path = ?`,
  ).get(genomeId, path)!;
}

/** Set the encryption_required flag on a genome (org admins only). */
export function setEncryptionRequired(genomeId: string, required: boolean): void {
  getDb().run(
    `UPDATE genomes SET encryption_required = ? WHERE id = ?`,
    [required ? 1 : 0, genomeId],
  );
}

export function getGenomeSectionsSince(genomeId: string, since: number): GenomeSection[] {
  return getDb().query<GenomeSection, [string, number]>(
    `SELECT * FROM genome_sections WHERE genome_id = ? AND server_seq > ? ORDER BY server_seq ASC`,
  ).all(genomeId, since);
}

export function getGenomeSectionByPath(genomeId: string, path: string): GenomeSection | null {
  return getDb().query<GenomeSection, [string, string]>(
    `SELECT * FROM genome_sections WHERE genome_id = ? AND path = ?`,
  ).get(genomeId, path);
}

/** Insert or replace a conflict record for a path (one active conflict per path). */
export function upsertGenomeConflict(
  genomeId: string,
  path: string,
  variantsJson: string,
): void {
  const db = getDb();
  // Remove any existing conflict for this path first
  db.run(`DELETE FROM genome_conflicts WHERE genome_id = ? AND path = ?`, [genomeId, path]);
  db.run(
    `INSERT INTO genome_conflicts (id, genome_id, path, variants_json)
     VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), genomeId, path, variantsJson],
  );
}

export function getGenomeConflicts(genomeId: string): GenomeConflict[] {
  return getDb().query<GenomeConflict, [string]>(
    `SELECT * FROM genome_conflicts WHERE genome_id = ? ORDER BY detected_at DESC`,
  ).all(genomeId);
}

export function resolveGenomeConflict(genomeId: string, path: string): void {
  getDb().run(
    `DELETE FROM genome_conflicts WHERE genome_id = ? AND path = ?`,
    [genomeId, path],
  );
}

export function logGenomePush(genomeId: string, clientId: string, path: string): void {
  getDb().run(
    `INSERT INTO genome_push_log (id, genome_id, client_id, path) VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), genomeId, clientId, path],
  );
}

/** Count push events for a clientId within the last windowMs milliseconds. */
export function countRecentGenomePushes(genomeId: string, clientId: string, windowMs: number): number {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = getDb().query<{ n: number }, [string, string, string]>(
    `SELECT COUNT(*) AS n FROM genome_push_log WHERE genome_id = ? AND client_id = ? AND at >= ?`,
  ).get(genomeId, clientId, since);
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Policy pack helpers (Phase 4)
// ---------------------------------------------------------------------------

export interface PolicyRule {
  match: string;
  kind: "tool" | "path" | "shell";
  reason?: string;
}

export interface PolicyRules {
  allow: PolicyRule[];
  deny: PolicyRule[];
  requireConfirm: PolicyRule[];
}

export interface PolicyPack {
  id: string;
  org_id: string;
  name: string;
  version: number;
  rules_json: string;
  author: string;
  created_at: string;
}

export interface PolicyCurrent {
  org_id: string;
  pack_id: string;
  set_at: string;
}

/** Insert a new policy pack version. Returns the new pack. */
export function createPolicyPack(
  orgId: string,
  name: string,
  rules: PolicyRules,
  author: string,
): PolicyPack {
  const db = getDb();
  // Determine next version number for this (org, name) pair.
  const row = db.query<{ max_v: number | null }, [string, string]>(
    `SELECT MAX(version) AS max_v FROM policy_packs WHERE org_id = ? AND name = ?`,
  ).get(orgId, name);
  const version = (row?.max_v ?? 0) + 1;
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO policy_packs (id, org_id, name, version, rules_json, author)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, orgId, name, version, JSON.stringify(rules), author],
  );
  // Update current pointer
  db.run(
    `INSERT INTO policy_current (org_id, pack_id, set_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(org_id) DO UPDATE SET pack_id = excluded.pack_id, set_at = excluded.set_at`,
    [orgId, id],
  );
  return getPolicyPackById(id)!;
}

export function getPolicyPackById(id: string): PolicyPack | null {
  return getDb()
    .query<PolicyPack, [string]>(`SELECT * FROM policy_packs WHERE id = ?`)
    .get(id);
}

export function getCurrentPolicyPack(orgId: string): PolicyPack | null {
  const db = getDb();
  const cur = db.query<PolicyCurrent, [string]>(
    `SELECT * FROM policy_current WHERE org_id = ?`,
  ).get(orgId);
  if (!cur) return null;
  return getPolicyPackById(cur.pack_id);
}

export function getPolicyPackHistory(orgId: string, limit = 20): PolicyPack[] {
  return getDb()
    .query<PolicyPack, [string, number]>(
      `SELECT * FROM policy_packs WHERE org_id = ? ORDER BY version DESC LIMIT ?`,
    )
    .all(orgId, limit);
}

export function getPolicyPackByVersion(orgId: string, name: string, version: number): PolicyPack | null {
  return getDb()
    .query<PolicyPack, [string, string, number]>(
      `SELECT * FROM policy_packs WHERE org_id = ? AND name = ? AND version = ?`,
    )
    .get(orgId, name, version);
}

/** Set a specific pack as the current one (for rollback). */
export function setCurrentPolicyPack(orgId: string, packId: string): void {
  getDb().run(
    `INSERT INTO policy_current (org_id, pack_id, set_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(org_id) DO UPDATE SET pack_id = excluded.pack_id, set_at = excluded.set_at`,
    [orgId, packId],
  );
}

// ---------------------------------------------------------------------------
// Audit event helpers (Phase 4)
// ---------------------------------------------------------------------------

export interface AuditEvent {
  id: string;
  org_id: string;
  user_id: string;
  tool: string;
  args_json: string;
  cwd_fingerprint: string;
  git_commit: string;
  at: string;
}

export interface AppendAuditEventParams {
  orgId: string;
  userId: string;
  tool: string;
  argsJson: string;
  cwdFingerprint: string;
  gitCommit: string;
  at?: string;
}

/** Append an immutable audit event. Returns the event id. */
export function appendAuditEvent(params: AppendAuditEventParams): string {
  const id = crypto.randomUUID();
  const at = params.at ?? new Date().toISOString();
  getDb().run(
    `INSERT INTO audit_events (id, org_id, user_id, tool, args_json, cwd_fingerprint, git_commit, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, params.orgId, params.userId, params.tool, params.argsJson, params.cwdFingerprint, params.gitCommit, at],
  );
  return id;
}

export interface QueryAuditEventsParams {
  orgId: string;
  from?: string;
  to?: string;
  userId?: string;
  tool?: string;
  limit?: number;
  offset?: number;
}

export function queryAuditEvents(params: QueryAuditEventsParams): AuditEvent[] {
  const db = getDb();
  const conditions: string[] = ["org_id = ?"];
  const bindings: SQLQueryBindings[] = [params.orgId];

  if (params.from) { conditions.push("at >= ?"); bindings.push(params.from); }
  if (params.to)   { conditions.push("at <= ?"); bindings.push(params.to); }
  if (params.userId) { conditions.push("user_id = ?"); bindings.push(params.userId); }
  if (params.tool)   { conditions.push("tool = ?"); bindings.push(params.tool); }

  const limit  = params.limit  ?? 100;
  const offset = params.offset ?? 0;
  bindings.push(limit, offset);

  const sql = `SELECT * FROM audit_events WHERE ${conditions.join(" AND ")} ORDER BY at DESC LIMIT ? OFFSET ?`;
  return db.query<AuditEvent, SQLQueryBindings[]>(sql).all(...bindings);
}

/** Stream all audit events for an org in ascending time order (for NDJSON export). */
export function streamAuditEvents(orgId: string): AuditEvent[] {
  return getDb()
    .query<AuditEvent, [string]>(
      `SELECT * FROM audit_events WHERE org_id = ? ORDER BY at ASC`,
    )
    .all(orgId);
}

// ---------------------------------------------------------------------------
// Status page helpers
// ---------------------------------------------------------------------------

export interface HealthCheck {
  id: string;
  component: string;
  status: string;
  latency_ms: number | null;
  checked_at: string;
  error_text: string | null;
}

export interface Incident {
  id: string;
  title: string;
  status: string;
  affected_components_json: string;
  created_at: string;
  resolved_at: string | null;
  body: string;
}

export interface IncidentUpdate {
  id: string;
  incident_id: string;
  status: string;
  body: string;
  posted_at: string;
}

export interface StatusSubscriber {
  email: string;
  confirmed_at: string | null;
  confirm_token: string;
  confirm_expires_at: string;
}

/** Insert a health-check result. */
export function insertHealthCheck(
  component: string,
  status: string,
  latencyMs: number | null,
  errorText: string | null,
): void {
  getDb().run(
    `INSERT INTO health_checks (id, component, status, latency_ms, error_text)
     VALUES (?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), component, status, latencyMs, errorText],
  );
}

/** Get the most recent health check for each component. */
export function getLatestHealthChecks(): HealthCheck[] {
  return getDb()
    .query<HealthCheck, []>(
      `SELECT h.*
       FROM health_checks h
       INNER JOIN (
         SELECT component, MAX(checked_at) AS max_at
         FROM health_checks
         GROUP BY component
       ) latest ON h.component = latest.component AND h.checked_at = latest.max_at`,
    )
    .all();
}

/** Get daily uptime rollups per component for the last N days. */
export function getUptimeHistory(days: number): Array<{
  component: string;
  date: string;
  total: number;
  ok: number;
}> {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return getDb()
    .query<{ component: string; date: string; total: number; ok: number }, [string]>(
      `SELECT
         component,
         strftime('%Y-%m-%d', checked_at) AS date,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok
       FROM health_checks
       WHERE strftime('%Y-%m-%d', checked_at) >= ?
       GROUP BY component, date
       ORDER BY component, date`,
    )
    .all(since);
}

/** Get recent incidents (last 30 days by default). */
export function getRecentIncidents(limitDays = 30): Incident[] {
  const since = new Date(Date.now() - limitDays * 86400_000).toISOString();
  return getDb()
    .query<Incident, [string]>(
      `SELECT * FROM incidents WHERE created_at >= ? ORDER BY created_at DESC`,
    )
    .all(since);
}

/** Get a single incident by id. */
export function getIncidentById(id: string): Incident | null {
  return getDb()
    .query<Incident, [string]>(`SELECT * FROM incidents WHERE id = ?`)
    .get(id);
}

/** Get all updates for an incident. */
export function getIncidentUpdates(incidentId: string): IncidentUpdate[] {
  return getDb()
    .query<IncidentUpdate, [string]>(
      `SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY posted_at ASC`,
    )
    .all(incidentId);
}

/** Create a new incident. */
export function createIncident(params: {
  title: string;
  status: string;
  affectedComponentsJson: string;
  body: string;
}): Incident {
  const db = getDb();
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO incidents (id, title, status, affected_components_json, body)
     VALUES (?, ?, ?, ?, ?)`,
    [id, params.title, params.status, params.affectedComponentsJson, params.body],
  );
  return getIncidentById(id)!;
}

/** Append an update to an incident and update its top-level status. */
export function appendIncidentUpdate(params: {
  incidentId: string;
  status: string;
  body: string;
}): IncidentUpdate {
  const db = getDb();
  const updateId = crypto.randomUUID();
  db.run(
    `INSERT INTO incident_updates (id, incident_id, status, body) VALUES (?, ?, ?, ?)`,
    [updateId, params.incidentId, params.status, params.body],
  );
  // Update top-level status
  const resolvedAt = params.status === "resolved"
    ? new Date().toISOString()
    : null;
  if (resolvedAt) {
    db.run(
      `UPDATE incidents SET status = ?, resolved_at = ? WHERE id = ?`,
      [params.status, resolvedAt, params.incidentId],
    );
  } else {
    db.run(
      `UPDATE incidents SET status = ? WHERE id = ?`,
      [params.status, params.incidentId],
    );
  }
  return db.query<IncidentUpdate, [string]>(
    `SELECT * FROM incident_updates WHERE id = ?`,
  ).get(updateId)!;
}

/** Upsert a status subscriber (idempotent on email). Returns whether it was a new row. */
export function upsertStatusSubscriber(
  email: string,
  confirmToken: string,
  confirmExpiresAt: string,
): boolean {
  const db = getDb();
  const existing = db
    .query<{ email: string }, [string]>(
      `SELECT email FROM status_subscribers WHERE email = ?`,
    )
    .get(email);
  if (existing) {
    // Refresh the token for re-subscription or re-confirmation
    db.run(
      `UPDATE status_subscribers SET confirm_token = ?, confirm_expires_at = ?, confirmed_at = NULL WHERE email = ?`,
      [confirmToken, confirmExpiresAt, email],
    );
    return false;
  }
  db.run(
    `INSERT INTO status_subscribers (email, confirm_token, confirm_expires_at) VALUES (?, ?, ?)`,
    [email, confirmToken, confirmExpiresAt],
  );
  return true;
}

/** Confirm a subscriber by token. Returns true on success. */
export function confirmStatusSubscriber(token: string): boolean {
  const db = getDb();
  const row = db
    .query<{ email: string; confirm_expires_at: string; confirmed_at: string | null }, [string]>(
      `SELECT email, confirm_expires_at, confirmed_at FROM status_subscribers WHERE confirm_token = ?`,
    )
    .get(token);
  if (!row) return false;
  if (new Date(row.confirm_expires_at) < new Date()) return false;
  db.run(
    `UPDATE status_subscribers SET confirmed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE confirm_token = ?`,
    [token],
  );
  return true;
}

/** Remove a subscriber by their unsubscribe token. Returns true if removed. */
export function removeStatusSubscriber(token: string): boolean {
  const db = getDb();
  const row = db
    .query<{ email: string }, [string]>(
      `SELECT email FROM status_subscribers WHERE confirm_token = ?`,
    )
    .get(token);
  if (!row) return false;
  db.run(`DELETE FROM status_subscribers WHERE confirm_token = ?`, [token]);
  return true;
}

/** Get all confirmed subscribers. */
export function getConfirmedStatusSubscribers(): StatusSubscriber[] {
  return getDb()
    .query<StatusSubscriber, []>(
      `SELECT * FROM status_subscribers WHERE confirmed_at IS NOT NULL`,
    )
    .all();
}

/** Count recent subscribe attempts for an email (rate-limit check). */
export function countRecentSubscribeAttempts(email: string, windowMs: number): number {
  // We use confirm_expires_at as a proxy for when the row was last written.
  // This is a simple approximation — good enough for a 3/day cap.
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = getDb()
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM status_subscribers WHERE email = ? AND confirm_expires_at >= ?`,
    )
    .get(email, since);
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Admin helpers
// ---------------------------------------------------------------------------

export function getUserByEmail(email: string): User | null {
  return getDb()
    .query<User, [string]>(
      `SELECT id, email, api_token, created_at, tier, org_id, org_role, is_admin, comp_expires_at FROM users WHERE email = ?`,
    )
    .get(email);
}

export function setUserAdmin(userId: string, isAdmin: boolean): void {
  getDb().run(`UPDATE users SET is_admin = ? WHERE id = ?`, [isAdmin ? 1 : 0, userId]);
}

export interface AdminUserRow {
  id: string;
  email: string;
  tier: string;
  created_at: string;
  is_admin: number;
  comp_expires_at: string | null;
  last_active: string | null;
  lifetime_tokens_saved: number;
}

export function adminListUsers(params: {
  q?: string;
  limit?: number;
  offset?: number;
}): AdminUserRow[] {
  const db = getDb();
  const limit  = params.limit  ?? 50;
  const offset = params.offset ?? 0;

  if (params.q) {
    const like = `%${params.q}%`;
    return db.query<AdminUserRow, [string, number, number]>(
      `SELECT u.id, u.email, u.tier, u.created_at, u.is_admin, u.comp_expires_at,
              MAX(s.uploaded_at) AS last_active,
              COALESCE(MAX(s.lifetime_tokens_saved), 0) AS lifetime_tokens_saved
         FROM users u
         LEFT JOIN stats_uploads s ON s.user_id = u.id
        WHERE u.email LIKE ?
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?`,
    ).all(like, limit, offset);
  }

  return db.query<AdminUserRow, [number, number]>(
    `SELECT u.id, u.email, u.tier, u.created_at, u.is_admin, u.comp_expires_at,
            MAX(s.uploaded_at) AS last_active,
            COALESCE(MAX(s.lifetime_tokens_saved), 0) AS lifetime_tokens_saved
       FROM users u
       LEFT JOIN stats_uploads s ON s.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?`,
  ).all(limit, offset);
}

export function adminCountUsers(): number {
  const row = getDb().query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM users`).get();
  return row?.n ?? 0;
}

export function adminGetRecentSignups(limit = 10): { id: string; email: string; tier: string; created_at: string }[] {
  return getDb().query<{ id: string; email: string; tier: string; created_at: string }, [number]>(
    `SELECT id, email, tier, created_at FROM users ORDER BY created_at DESC LIMIT ?`,
  ).all(limit);
}

export interface OverviewCounts {
  total_users: number;
  active_pro: number;
  active_team: number;
  mrr_cents: number;
  llm_calls_today: number;
  genome_syncs_today: number;
}

export function adminGetOverviewCounts(): OverviewCounts {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const total_users = adminCountUsers();

  const proRow = db.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM subscriptions WHERE tier = 'pro' AND status = 'active'`,
  ).get();
  const active_pro = proRow?.n ?? 0;

  const teamRow = db.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM subscriptions WHERE tier = 'team' AND status = 'active'`,
  ).get();
  const active_team = teamRow?.n ?? 0;

  // MRR: pro = $10/mo, team = $25/mo (simple estimate — replace with Stripe amount when available)
  const mrr_cents = active_pro * 1000 + active_team * 2500;

  const llmRow = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM llm_calls WHERE at >= ?`,
  ).get(`${today}T00:00:00Z`);
  const llm_calls_today = llmRow?.n ?? 0;

  const genomeRow = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM genome_push_log WHERE at >= ?`,
  ).get(`${today}T00:00:00Z`);
  const genome_syncs_today = genomeRow?.n ?? 0;

  return { total_users, active_pro, active_team, mrr_cents, llm_calls_today, genome_syncs_today };
}

export interface DailyRevenue {
  date: string;
  revenue_cents: number;
}

export function adminGetRevenueTimeline(from: string, to: string): DailyRevenue[] {
  // Revenue = daily_usage.total_cost converted to cents (approximate),
  // plus we can aggregate from llm_calls per day.
  // For now: sum llm cost by day as proxy (Stripe net would need webhook data).
  const db = getDb();
  return db.query<{ date: string; revenue_cents: number }, [string, string]>(
    `SELECT date, CAST(ROUND(SUM(total_cost) * 100) AS INTEGER) AS revenue_cents
       FROM daily_usage
      WHERE date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date ASC`,
  ).all(from, to);
}

export interface LlmUsageByTier {
  tier: string;
  date: string;
  calls: number;
}

export function adminGetLlmUsageByTier(days = 7): LlmUsageByTier[] {
  const db = getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return db.query<LlmUsageByTier, [string]>(
    `SELECT u.tier, substr(l.at, 1, 10) AS date, COUNT(*) AS calls
       FROM llm_calls l
       JOIN users u ON u.id = l.user_id
      WHERE l.at >= ?
      GROUP BY u.tier, substr(l.at, 1, 10)
      ORDER BY date ASC`,
  ).all(`${since}T00:00:00Z`);
}

export interface AdminUserDetail {
  user: User;
  subscriptions: Subscription[];
  stats_uploads: StatsUpload[];
  recent_llm_calls: LlmCall[];
  active_genome_ids: string[];
  audit_event_count: number;
}

export function adminGetUserDetail(userId: string): AdminUserDetail | null {
  const db = getDb();
  const user = getUserById(userId);
  if (!user) return null;

  const subscriptions = db.query<Subscription, [string]>(
    `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC`,
  ).all(userId);

  const stats_uploads = db.query<StatsUpload, [string]>(
    `SELECT * FROM stats_uploads WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT 10`,
  ).all(userId);

  const recent_llm_calls = getLlmCallsForUser(userId, 20);

  const genomeRows = db.query<{ id: string }, [string]>(
    `SELECT g.id FROM genomes g WHERE g.org_id = (SELECT org_id FROM users WHERE id = ? LIMIT 1)`,
  ).all(userId);
  const active_genome_ids = genomeRows.map((r) => r.id);

  const auditRow = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ?`,
  ).get(userId);
  const audit_event_count = auditRow?.n ?? 0;

  return { user, subscriptions, stats_uploads, recent_llm_calls, active_genome_ids, audit_event_count };
}

export function adminSetUserComp(userId: string, tier: string, compExpiresAt: string): void {
  getDb().run(
    `UPDATE users SET tier = ?, comp_expires_at = ? WHERE id = ?`,
    [tier, compExpiresAt, userId],
  );
}

export interface RecentPayment {
  user_id: string;
  email: string;
  tier: string;
  created_at: string;
  stripe_subscription_id: string;
}

export function adminGetRecentPayments(limit = 10): RecentPayment[] {
  return getDb().query<RecentPayment, [number]>(
    `SELECT s.user_id, u.email, s.tier, s.created_at, s.stripe_subscription_id
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
      WHERE s.status = 'active'
      ORDER BY s.created_at DESC
      LIMIT ?`,
  ).all(limit);
}

export function adminQueryAuditEvents(params: {
  orgId?: string;
  limit?: number;
  offset?: number;
}): AuditEvent[] {
  const db = getDb();
  const limit  = params.limit  ?? 100;
  const offset = params.offset ?? 0;

  if (params.orgId) {
    return db.query<AuditEvent, [string, number, number]>(
      `SELECT * FROM audit_events WHERE org_id = ? ORDER BY at DESC LIMIT ? OFFSET ?`,
    ).all(params.orgId, limit, offset);
  }

  return db.query<AuditEvent, [number, number]>(
    `SELECT * FROM audit_events ORDER BY at DESC LIMIT ? OFFSET ?`,
  ).all(limit, offset);
}

// Broadcast rate-limit: track last broadcast timestamp in memory
let _lastBroadcastAt: number | null = null;
const BROADCAST_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export function checkBroadcastRateLimit(): boolean {
  const now = Date.now();
  if (_lastBroadcastAt !== null && now - _lastBroadcastAt < BROADCAST_COOLDOWN_MS) {
    return false;
  }
  _lastBroadcastAt = now;
  return true;
}

/** Test helper — reset broadcast rate limit state. */
export function _resetBroadcastRateLimit(): void {
  _lastBroadcastAt = null;
}

export function adminGetAllUserEmails(tierFilter?: string): { id: string; email: string }[] {
  const db = getDb();
  if (tierFilter) {
    return db.query<{ id: string; email: string }, [string]>(
      `SELECT id, email FROM users WHERE tier = ?`,
    ).all(tierFilter);
  }
  return db.query<{ id: string; email: string }, []>(
    `SELECT id, email FROM users`,
  ).all();
}

// ---------------------------------------------------------------------------
// Team types + helpers
// ---------------------------------------------------------------------------

export interface Team {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
}

export interface TeamMember {
  team_id: string;
  user_id: string;
  role: "admin" | "member";
  joined_at: string;
}

export interface TeamInvite {
  token: string;
  team_id: string;
  email: string;
  role: "admin" | "member";
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function createTeam(name: string, ownerUserId: string): Team {
  const db = getDb();
  const id = randomId("tm");
  const createdAt = now();
  db.run(
    `INSERT INTO teams (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)`,
    [id, name, ownerUserId, createdAt],
  );
  // Owner is an implicit admin member.
  db.run(
    `INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)`,
    [id, ownerUserId, createdAt],
  );
  return { id, name, owner_user_id: ownerUserId, created_at: createdAt };
}

export function getTeamById(teamId: string): Team | null {
  return getDb().query<Team, [string]>(
    `SELECT id, name, owner_user_id, created_at FROM teams WHERE id = ?`,
  ).get(teamId);
}

export function getTeamForUser(userId: string): { team: Team; role: "admin" | "member" } | null {
  const row = getDb().query<
    { id: string; name: string; owner_user_id: string; created_at: string; role: "admin" | "member" },
    [string]
  >(
    `SELECT t.id, t.name, t.owner_user_id, t.created_at, m.role
     FROM teams t
     JOIN team_members m ON m.team_id = t.id
     WHERE m.user_id = ?
     LIMIT 1`,
  ).get(userId);
  if (!row) return null;
  const { role, ...team } = row;
  return { team, role };
}

export function listTeamMembers(teamId: string): Array<TeamMember & { email: string }> {
  return getDb().query<TeamMember & { email: string }, [string]>(
    `SELECT m.team_id, m.user_id, m.role, m.joined_at, u.email
     FROM team_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ?
     ORDER BY m.joined_at ASC`,
  ).all(teamId);
}

export function createTeamInvite(params: {
  teamId: string;
  email: string;
  role: "admin" | "member";
  invitedBy: string;
  ttlMs?: number;
}): TeamInvite {
  const ttl = params.ttlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  const token = randomId("inv").slice(4); // drop the "inv_" prefix for link hygiene
  const invite: TeamInvite = {
    token,
    team_id: params.teamId,
    email: params.email,
    role: params.role,
    invited_by: params.invitedBy,
    expires_at: new Date(Date.now() + ttl).toISOString(),
    accepted_at: null,
    revoked_at: null,
    created_at: now(),
  };
  getDb().run(
    `INSERT INTO team_invites (token, team_id, email, role, invited_by, expires_at, accepted_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [invite.token, invite.team_id, invite.email, invite.role, invite.invited_by, invite.expires_at, invite.created_at],
  );
  return invite;
}

export function getTeamInvite(token: string): TeamInvite | null {
  return getDb().query<TeamInvite, [string]>(
    `SELECT token, team_id, email, role, invited_by, expires_at, accepted_at, revoked_at, created_at
     FROM team_invites WHERE token = ?`,
  ).get(token);
}

export function listTeamInvites(teamId: string): TeamInvite[] {
  return getDb().query<TeamInvite, [string]>(
    `SELECT token, team_id, email, role, invited_by, expires_at, accepted_at, revoked_at, created_at
     FROM team_invites
     WHERE team_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now')
     ORDER BY created_at DESC`,
  ).all(teamId);
}

export function revokeTeamInvite(token: string): void {
  getDb().run(`UPDATE team_invites SET revoked_at = ? WHERE token = ?`, [now(), token]);
}

/**
 * Atomically accept an invite: mark it accepted, add the invitee as a team
 * member. Returns the membership on success, or null if the invite is
 * invalid / expired / already used / revoked, or if the accepting user's
 * email doesn't match the invited email (prevents token-bearer hijack).
 *
 * Also refuses self-acceptance (the inviter can't accept their own invite),
 * which is a no-op anyway but could surface confusing audit trails.
 */
export function acceptTeamInvite(token: string, userId: string): TeamMember | null {
  const db = getDb();
  const txn = db.transaction(() => {
    const invite = getTeamInvite(token);
    if (!invite) return null;
    if (invite.accepted_at || invite.revoked_at) return null;
    if (new Date(invite.expires_at) <= new Date()) return null;
    if (invite.invited_by === userId) return null;

    const user = getUserById(userId);
    if (!user) return null;
    // Email comparison is case-insensitive and whitespace-tolerant — callers
    // may capitalize differently across magic-link signup and invite-send.
    if (user.email.trim().toLowerCase() !== invite.email.trim().toLowerCase()) {
      return null;
    }

    const joinedAt = now();
    db.run(`UPDATE team_invites SET accepted_at = ? WHERE token = ?`, [joinedAt, token]);
    db.run(
      `INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role`,
      [invite.team_id, userId, invite.role, joinedAt],
    );
    return {
      team_id: invite.team_id,
      user_id: userId,
      role: invite.role,
      joined_at: joinedAt,
    } satisfies TeamMember;
  });
  return txn();
}
