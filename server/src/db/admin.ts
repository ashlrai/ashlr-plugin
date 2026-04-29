/**
 * db/admin.ts — Admin dashboard queries and status page helpers.
 *
 * Extracted from db.ts as part of Track C decomposition (v1.24).
 */

import { getDb } from "./connection";
import { getUserById } from "./users";
import { getLlmCallsForUser } from "./stats";
import type { User } from "./users";
import type { Subscription } from "./billing";
import type { StatsUpload, LlmCall } from "./stats";
import type { AuditEvent } from "./genome";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export interface OverviewCounts {
  total_users: number;
  active_pro: number;
  active_team: number;
  mrr_cents: number;
  llm_calls_today: number;
  genome_syncs_today: number;
}

export interface DailyRevenue {
  date: string;
  revenue_cents: number;
}

export interface LlmUsageByTier {
  tier: string;
  date: string;
  calls: number;
}

export interface AdminUserDetail {
  user: User;
  subscriptions: Subscription[];
  stats_uploads: StatsUpload[];
  recent_llm_calls: LlmCall[];
  active_genome_ids: string[];
  audit_event_count: number;
}

export interface RecentPayment {
  user_id: string;
  email: string;
  tier: string;
  created_at: string;
  stripe_subscription_id: string;
}

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

// ---------------------------------------------------------------------------
// Admin user queries
// ---------------------------------------------------------------------------

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
// Status page helpers
// ---------------------------------------------------------------------------

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
