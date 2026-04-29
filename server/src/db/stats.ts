/**
 * db/stats.ts — Stats uploads, daily usage caps, LLM call log, nudge events.
 *
 * Extracted from db.ts as part of Track C decomposition (v1.24).
 */

import { getDb } from "./connection";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatsUpload {
  id: string;
  user_id: string;
  uploaded_at: string;
  lifetime_calls: number;
  lifetime_tokens_saved: number;
  by_tool_json: string;
  by_day_json: string;
  machine_id: string | null;
}

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

export interface LogLlmCallParams {
  userId: string;
  toolName: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  cached: boolean;
}

export interface NudgeEventRow {
  userId: string;
  ts: string;
  event: "nudge_shown" | "nudge_clicked" | "nudge_dismissed_implicitly";
  sessionId: string;
  tokenCount: number;
  variant: string;
  nudgeId: string;
}

// ---------------------------------------------------------------------------
// Stats uploads
// ---------------------------------------------------------------------------

export function upsertStatsUpload(
  userId: string,
  lifetimeCalls: number,
  lifetimeTokensSaved: number,
  byToolJson: string,
  byDayJson: string,
  machineId?: string | null,
): StatsUpload {
  const db = getDb();
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO stats_uploads
       (id, user_id, lifetime_calls, lifetime_tokens_saved, by_tool_json, by_day_json, machine_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, lifetimeCalls, lifetimeTokensSaved, byToolJson, byDayJson, machineId ?? null],
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
 *
 * machine_count = COUNT(DISTINCT machine_id). NULL machine_ids (legacy rows
 * backfilled to 'legacy' on migration) count as a single collective machine.
 */
export function aggregateUploads(userId: string): {
  lifetime_calls: number;
  lifetime_tokens_saved: number;
  by_tool: Record<string, number>;
  by_day: Record<string, number>;
  machine_count: number;
} {
  const db = getDb();
  const rows = db.query<StatsUpload, [string]>(
    `SELECT * FROM stats_uploads WHERE user_id = ? ORDER BY uploaded_at ASC`,
  ).all(userId);

  let calls = 0;
  let tokens = 0;
  const byTool: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  const machineIds = new Set<string>();

  for (const row of rows) {
    // We keep the max of lifetime fields (they're cumulative per device)
    calls  = Math.max(calls, row.lifetime_calls);
    tokens = Math.max(tokens, row.lifetime_tokens_saved);

    // Track distinct machines; NULL treated as 'legacy' (backfill sentinel)
    machineIds.add(row.machine_id ?? "legacy");

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

  return {
    lifetime_calls: calls,
    lifetime_tokens_saved: tokens,
    by_tool: byTool,
    by_day: byDay,
    machine_count: machineIds.size,
  };
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
// Nudge telemetry
// ---------------------------------------------------------------------------

/** Bulk-insert nudge events for a user. Returns the number of rows stored. */
export function insertNudgeEvents(rows: NudgeEventRow[]): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO nudge_events (user_id, ts, event, session_id, token_count, variant, nudge_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(r.userId, r.ts, r.event, r.sessionId, r.tokenCount, r.variant, r.nudgeId);
      n += 1;
    }
  });
  tx();
  return n;
}

/** Aggregate a user's nudge telemetry across all uploads. */
export function aggregateNudgeEvents(userId: string): {
  shown: number;
  clicked: number;
  dismissed: number;
} {
  const db = getDb();
  const row = db
    .query<
      { shown: number; clicked: number; dismissed: number },
      [string]
    >(
      `SELECT
         SUM(CASE WHEN event = 'nudge_shown' THEN 1 ELSE 0 END) AS shown,
         SUM(CASE WHEN event = 'nudge_clicked' THEN 1 ELSE 0 END) AS clicked,
         SUM(CASE WHEN event = 'nudge_dismissed_implicitly' THEN 1 ELSE 0 END) AS dismissed
       FROM nudge_events WHERE user_id = ?`,
    )
    .get(userId);
  return {
    shown:     row?.shown ?? 0,
    clicked:   row?.clicked ?? 0,
    dismissed: row?.dismissed ?? 0,
  };
}
