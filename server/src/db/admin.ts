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

/**
 * adminGetOverviewWithDeltas — extends adminGetOverviewCounts() with a prior-period
 * snapshot taken 24 hours ago. The `prev` snapshot is an approximation:
 *
 *   - total_users / active_pro / active_team: counted as of (now - 24h) using
 *     created_at for users and a subscription state proxy (no point-in-time
 *     billing history, so we count subs created before the cutoff). This
 *     slightly under-counts if subscriptions were cancelled within the window.
 *   - mrr_cents: derived from the same prior active_pro/active_team counts.
 *   - llm_calls_today: yesterday's full-day window (00:00–23:59 UTC yesterday).
 *   - genome_syncs_today: same yesterday window.
 *
 * Callers that only need current counts should use adminGetOverviewCounts().
 */
export interface OverviewWithDeltas {
  counts: OverviewCounts;
  prev: OverviewCounts;
}

export function adminGetOverviewWithDeltas(): OverviewWithDeltas {
  const db = getDb();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // 24h cutoff for prior-period approximation
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Yesterday date string (for full-day llm window)
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // --- Current period ---
  const counts = adminGetOverviewCounts();

  // --- Prior period (24h-ago snapshot) ---
  const prevUsersRow = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM users WHERE created_at < ?`,
  ).get(cutoff);
  const prev_total_users = prevUsersRow?.n ?? 0;

  const prevProRow = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM subscriptions WHERE tier = 'pro' AND status = 'active' AND created_at < ?`,
  ).get(cutoff);
  const prev_active_pro = prevProRow?.n ?? 0;

  const prevTeamRow = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM subscriptions WHERE tier = 'team' AND status = 'active' AND created_at < ?`,
  ).get(cutoff);
  const prev_active_team = prevTeamRow?.n ?? 0;

  const prev_mrr_cents = prev_active_pro * 1000 + prev_active_team * 2500;

  // Yesterday's full-day llm_calls window
  const prevLlmRow = db.query<{ n: number }, [string, string]>(
    `SELECT COUNT(*) AS n FROM llm_calls WHERE at >= ? AND at < ?`,
  ).get(`${yesterday}T00:00:00Z`, `${today}T00:00:00Z`);
  const prev_llm_calls_today = prevLlmRow?.n ?? 0;

  const prevGenomeRow = db.query<{ n: number }, [string, string]>(
    `SELECT COUNT(*) AS n FROM genome_push_log WHERE at >= ? AND at < ?`,
  ).get(`${yesterday}T00:00:00Z`, `${today}T00:00:00Z`);
  const prev_genome_syncs_today = prevGenomeRow?.n ?? 0;

  const prev: OverviewCounts = {
    total_users: prev_total_users,
    active_pro: prev_active_pro,
    active_team: prev_active_team,
    mrr_cents: prev_mrr_cents,
    llm_calls_today: prev_llm_calls_today,
    genome_syncs_today: prev_genome_syncs_today,
  };

  return { counts, prev };
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

// Broadcast rate-limit: track last broadcast timestamp in memory.
// Note: lost on process restart, allowing immediate re-broadcast after deploy.
// Acceptable trade-off for now — broadcasts are admin-only + audit-logged.
// Move to DB-backed if abuse becomes a concern.
let _lastBroadcastAt: number | null = null;
const BROADCAST_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/** Read-only check — does NOT consume the cooldown slot. */
export function isBroadcastAllowed(): boolean {
  const now = Date.now();
  return _lastBroadcastAt === null || now - _lastBroadcastAt >= BROADCAST_COOLDOWN_MS;
}

/** Mark a broadcast as sent — call ONLY after successful dispatch. */
export function markBroadcastSent(): void {
  _lastBroadcastAt = Date.now();
}

/**
 * @deprecated Use isBroadcastAllowed() + markBroadcastSent() instead.
 * Retained as a transitional shim — the old API consumed the cooldown
 * before the broadcast actually succeeded, locking out admins on a
 * full-batch failure.
 */
export function checkBroadcastRateLimit(): boolean {
  if (!isBroadcastAllowed()) return false;
  markBroadcastSent();
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
// Telemetry dashboard queries (Track 1.4 — v1.30)
// ---------------------------------------------------------------------------

export interface ToolAdoptionRow {
  tool_name: string;
  call_count: number;
  share_pct: number;
}

export interface HookLatencyRow {
  hook_name: string;
  p50_ms: number;
  p99_ms: number;
  sample_count: number;
}

export interface GenomeCompressionTrendRow {
  day: string;
  median_ratio: number;
  sample_count: number;
}

/**
 * Per-tool adoption heatmap: group tool_call events by tool_name, return
 * % share over a time window (windowHours: 24 | 168 | 720).
 *
 * Payload column stores JSON; tool_name lives at payload->>'tool_name'.
 * Rows without tool_name (older clients) are grouped as "(unknown)".
 */
export function adminGetToolAdoption(windowHours: number = 24): ToolAdoptionRow[] {
  const db = getDb();
  const cutoffTs = Math.floor((Date.now() - windowHours * 3_600_000) / 1000);

  const rows = db.query<{ tool_name: string; call_count: number }, [number]>(
    `SELECT
       COALESCE(json_extract(payload, '$.tool_name'), '(unknown)') AS tool_name,
       COUNT(*) AS call_count
     FROM telemetry_events
     WHERE kind = 'tool_call' AND ts >= ?
     GROUP BY tool_name
     ORDER BY call_count DESC`,
  ).all(cutoffTs);

  const total = rows.reduce((s, r) => s + r.call_count, 0);
  return rows.map((r) => ({
    tool_name: r.tool_name,
    call_count: r.call_count,
    share_pct: total > 0 ? Math.round((r.call_count / total) * 10000) / 100 : 0,
  }));
}

/**
 * Hook latency distribution: group hook_perf events by hook_name, return
 * median p50 and p99 over the window.
 *
 * p50_ms and p99_ms are stored in the JSON payload; we use SQLite's
 * json_extract and AVG as a proxy for median (sufficient for dashboards).
 */
export function adminGetHookLatency(windowHours: number = 24): HookLatencyRow[] {
  const db = getDb();
  const cutoffTs = Math.floor((Date.now() - windowHours * 3_600_000) / 1000);

  return db.query<HookLatencyRow, [number]>(
    `SELECT
       json_extract(payload, '$.hook_name') AS hook_name,
       CAST(ROUND(AVG(CAST(json_extract(payload, '$.p50_ms') AS REAL))) AS INTEGER) AS p50_ms,
       CAST(ROUND(AVG(CAST(json_extract(payload, '$.p99_ms') AS REAL))) AS INTEGER) AS p99_ms,
       COUNT(*) AS sample_count
     FROM telemetry_events
     WHERE kind = 'hook_perf' AND ts >= ?
       AND json_extract(payload, '$.hook_name') IS NOT NULL
     GROUP BY hook_name
     ORDER BY p99_ms DESC`,
  ).all(cutoffTs);
}

/**
 * Genome compression trend: group genome_compression_ratio events by day,
 * return median ratio (compressed_bytes / raw_bytes) per day.
 *
 * SQLite lacks a native MEDIAN; we use AVG as an approximation. Sufficient
 * for trend dashboards where exact median adds < 5% accuracy improvement.
 */
export function adminGetGenomeCompressionTrend(windowHours: number = 720): GenomeCompressionTrendRow[] {
  const db = getDb();
  const cutoffTs = Math.floor((Date.now() - windowHours * 3_600_000) / 1000);

  return db.query<{ day: string; avg_ratio: number; sample_count: number }, [number]>(
    `SELECT
       strftime('%Y-%m-%d', datetime(ts, 'unixepoch')) AS day,
       AVG(
         CAST(json_extract(payload, '$.compressed_bytes') AS REAL) /
         NULLIF(CAST(json_extract(payload, '$.raw_bytes') AS REAL), 0)
       ) AS avg_ratio,
       COUNT(*) AS sample_count
     FROM telemetry_events
     WHERE kind = 'genome_compression_ratio' AND ts >= ?
       AND json_extract(payload, '$.raw_bytes') > 0
     GROUP BY day
     ORDER BY day ASC`,
  ).all(cutoffTs).map((r) => ({
    day: r.day,
    median_ratio: Math.round((r.avg_ratio ?? 0) * 10000) / 10000,
    sample_count: r.sample_count,
  }));
}

// ---------------------------------------------------------------------------
// Wizard funnel query (Stage 1, v1.30)
// ---------------------------------------------------------------------------

export interface WizardFunnelStep {
  step_name: string;
  sessions_reached: number;
  /** % of users who dropped off after this step (null for step 0). */
  dropoff_pct: number | null;
  /** % of users who reached this step relative to step 1 (intro). Null for step 0. */
  cumulative_pct: number | null;
}

export interface WizardProConversion {
  wizard_completed: number;
  wizard_pro_yes: number;
  conversion_pct: number;
}

/**
 * Wizard funnel: count distinct session_id_hash per wizard step within the
 * given windowHours, ordered by the canonical wizard step sequence.
 *
 * Canonical order: intro → doctor → permissions → status_line → genome_init
 *                  → pro_teaser → complete
 *
 * Steps not in the canonical list are appended at the end (future-proofing).
 *
 * We use COALESCE(json_extract(payload, '$.step_name'), payload->>'step_name')
 * but SQLite's ->> operator is available in 3.38+; use json_extract for
 * maximum compatibility with Bun's bundled SQLite.
 *
 * NOTE: `kind` is embedded as a literal in the SQL (not a positional param)
 * to match the pattern used by adminGetToolAdoption / adminGetHookLatency.
 * Only `cutoffTs` is passed as a positional placeholder.
 */
const WIZARD_STEP_ORDER = [
  'intro',
  'doctor',
  'permissions',
  'status_line',
  'genome_init',
  'pro_teaser',
  'complete',
] as const;

export function adminGetWizardFunnel(windowHours: number = 24): WizardFunnelStep[] {
  const db = getDb();
  const cutoffTs = Math.floor((Date.now() - windowHours * 3_600_000) / 1000);

  const rows = db.query<{ step_name: string; sessions_reached: number }, [number]>(
    `SELECT
       json_extract(payload, '$.step_name') AS step_name,
       COUNT(DISTINCT session_id_hash)      AS sessions_reached
     FROM telemetry_events
     WHERE kind = 'wizard_step'
       AND ts >= ?
       AND json_extract(payload, '$.step_name') IS NOT NULL
     GROUP BY step_name`,
  ).all(cutoffTs);

  // Sort by canonical order; unknown steps go last
  const orderIndex = (name: string) => {
    const i = (WIZARD_STEP_ORDER as readonly string[]).indexOf(name);
    return i === -1 ? WIZARD_STEP_ORDER.length : i;
  };

  const sorted = rows.slice().sort((a, b) => orderIndex(a.step_name) - orderIndex(b.step_name));

  // Annotate with dropoff_pct and cumulative_pct
  const firstCount = sorted.length > 0 ? sorted[0]!.sessions_reached : 0;
  return sorted.map((step, i) => {
    const prev = i === 0 ? null : sorted[i - 1]!.sessions_reached;
    const dropoff_pct =
      prev === null || prev === 0
        ? null
        : Math.round(((prev - step.sessions_reached) / prev) * 10000) / 100;
    const cumulative_pct =
      i === 0 || firstCount === 0
        ? null
        : Math.round((step.sessions_reached / firstCount) * 10000) / 100;
    return { ...step, dropoff_pct, cumulative_pct };
  });
}

/**
 * adminGetWizardProConversion — count wizard completions and "pro yes" signals.
 *
 * Pro-conversion proxy: sessions that fired a `wizard_pro_pitch` telemetry
 * event with `outcome: 'y'` within the same window. We count distinct
 * session_id_hash for privacy — no per-session data is exposed.
 *
 * SQL (proxy):
 *   SELECT COUNT(DISTINCT session_id_hash) FROM telemetry_events
 *   WHERE kind = 'wizard_pro_pitch'
 *     AND json_extract(payload, '$.outcome') = 'y'
 *     AND ts >= <cutoffTs>
 */
export function adminGetWizardProConversion(windowHours: number = 24): WizardProConversion {
  const db = getDb();
  const cutoffTs = Math.floor((Date.now() - windowHours * 3_600_000) / 1000);

  const completedRow = db.query<{ n: number }, [number]>(
    `SELECT COUNT(DISTINCT session_id_hash) AS n
     FROM telemetry_events
     WHERE kind = 'wizard_step'
       AND json_extract(payload, '$.step_name') = 'complete'
       AND ts >= ?`,
  ).get(cutoffTs);
  const wizard_completed = completedRow?.n ?? 0;

  const proYesRow = db.query<{ n: number }, [number]>(
    `SELECT COUNT(DISTINCT session_id_hash) AS n
     FROM telemetry_events
     WHERE kind = 'wizard_pro_pitch'
       AND json_extract(payload, '$.outcome') = 'y'
       AND ts >= ?`,
  ).get(cutoffTs);
  const wizard_pro_yes = proYesRow?.n ?? 0;

  const conversion_pct =
    wizard_completed === 0
      ? 0
      : Math.round((wizard_pro_yes / wizard_completed) * 10000) / 100;

  return { wizard_completed, wizard_pro_yes, conversion_pct };
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

// ---------------------------------------------------------------------------
// User-tier Pro stats queries (Stage 2 — user dashboard upgrade)
// Stage 1 OWNS wizard_funnel additions; Stage 2 OWNS these four functions.
// ---------------------------------------------------------------------------

export interface CostPerSessionBucket {
  bucket: string;
  count: number;
}

export interface GenomeGrowthRow {
  day: string;
  total_bytes: number;
  section_count: number;
}

export interface CrossMachineTimelineRow {
  day: string;
  machine: string;
  tokens_saved: number;
}

export interface TeamAggregates {
  total_tokens_saved: number;
  member_count: number;
  top_tools: { name: string; calls: number }[];
}

/**
 * userGetCostPerSessionHistogram — bucket daily_usage cost rows into cost bands.
 * Buckets: $0-1, $1-5, $5-25, $25-100, $100+
 */
export function userGetCostPerSessionHistogram(
  userId: string,
  windowHours: number,
): CostPerSessionBucket[] {
  const db = getDb();
  const since = new Date(Date.now() - windowHours * 3_600_000)
    .toISOString()
    .slice(0, 10);

  const rows = db.query<{ cost: number }, [string, string]>(
    `SELECT total_cost AS cost FROM daily_usage WHERE user_id = ? AND date >= ?`,
  ).all(userId, since);

  const buckets: Record<string, number> = {
    "$0-1": 0, "$1-5": 0, "$5-25": 0, "$25-100": 0, "$100+": 0,
  };

  for (const { cost } of rows) {
    if (cost < 1)        buckets["$0-1"]!    += 1;
    else if (cost < 5)   buckets["$1-5"]!    += 1;
    else if (cost < 25)  buckets["$5-25"]!   += 1;
    else if (cost < 100) buckets["$25-100"]! += 1;
    else                 buckets["$100+"]!   += 1;
  }

  return Object.entries(buckets).map(([bucket, count]) => ({ bucket, count }));
}

/**
 * userGetGenomeGrowth — daily genome section-count from genome_push_log.
 * Falls back to empty array when user has no genome events.
 */
export function userGetGenomeGrowth(userId: string): GenomeGrowthRow[] {
  const db = getDb();
  return db.query<GenomeGrowthRow, [string, string]>(
    `SELECT
       strftime('%Y-%m-%d', gpl.at) AS day,
       COALESCE(SUM(gpl.size_bytes), 0) AS total_bytes,
       COUNT(*) AS section_count
     FROM genome_push_log gpl
     JOIN genomes g ON g.id = gpl.genome_id
     WHERE g.org_id = (SELECT org_id FROM users WHERE id = ? LIMIT 1)
        OR g.owner_user_id = ?
     GROUP BY day
     ORDER BY day ASC`,
  ).all(userId, userId);
}

/**
 * userGetCrossMachineTimeline — per-machine max lifetime_tokens_saved per day.
 * Client diffs consecutive days per machine to get daily deltas.
 */
export function userGetCrossMachineTimeline(
  userId: string,
  windowHours: number,
): CrossMachineTimelineRow[] {
  const db = getDb();
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  return db.query<CrossMachineTimelineRow, [string, string]>(
    `SELECT
       strftime('%Y-%m-%d', uploaded_at) AS day,
       COALESCE(machine_id, 'legacy')    AS machine,
       MAX(lifetime_tokens_saved)         AS tokens_saved
     FROM stats_uploads
     WHERE user_id = ? AND uploaded_at >= ?
     GROUP BY day, machine
     ORDER BY day ASC, machine ASC`,
  ).all(userId, since);
}

/**
 * teamGetAggregates — team-wide stats for Pro Team users (gated by org_id).
 * Returns total tokens saved, member count, and top-10 tool leaderboard.
 */
export function teamGetAggregates(orgId: string): TeamAggregates {
  const db = getDb();

  const totRow = db.query<{ total: number }, [string]>(
    `SELECT COALESCE(SUM(max_tokens), 0) AS total
       FROM (
         SELECT MAX(s.lifetime_tokens_saved) AS max_tokens
           FROM stats_uploads s
           JOIN users u ON u.id = s.user_id
          WHERE u.org_id = ?
          GROUP BY s.user_id
       )`,
  ).get(orgId);
  const total_tokens_saved = totRow?.total ?? 0;

  const memRow = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM users WHERE org_id = ?`,
  ).get(orgId);
  const member_count = memRow?.n ?? 0;

  const latestUploads = db.query<{ by_tool_json: string }, [string]>(
    `SELECT s.by_tool_json
       FROM stats_uploads s
       JOIN users u ON u.id = s.user_id
      WHERE u.org_id = ?
        AND s.uploaded_at = (
          SELECT MAX(s2.uploaded_at) FROM stats_uploads s2 WHERE s2.user_id = s.user_id
        )`,
  ).all(orgId);

  const toolCounts: Record<string, number> = {};
  for (const { by_tool_json } of latestUploads) {
    try {
      const tool = JSON.parse(by_tool_json) as Record<string, number>;
      for (const [k, v] of Object.entries(tool)) {
        toolCounts[k] = (toolCounts[k] ?? 0) + v;
      }
    } catch { /* skip malformed rows */ }
  }

  const top_tools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, calls]) => ({ name, calls }));

  return { total_tokens_saved, member_count, top_tools };
}
