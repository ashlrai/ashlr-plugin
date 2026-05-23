/**
 * admin-orchestration-runs.ts — Founder-only read endpoint for orchestration_runs.
 *
 * Sibling to admin-wad-d.ts (PR #67) and admin-discovery-propagation.ts. The
 * founder dashboard at site/app/admin/wad-d renders an "Orchestration
 * Activity" panel from this endpoint.
 *
 * Endpoint:
 *   GET /admin/orchestration-runs?days=N&limit=M
 *     Auth:    Authorization: Bearer <ASHLR_ADMIN_TRIGGER_TOKEN>
 *     Query:   days  — int, default 7, capped at 90.
 *              limit — int, default 50, capped at 200.
 *     200:     { runs: [...], summary: {...}, requestId }
 *     401:     missing/wrong bearer
 *     503:     ASHLR_ADMIN_TRIGGER_TOKEN env unset on server
 *
 * Security mirrors admin-wad-d.ts:
 *   - timingSafeEqual bearer compare (constant time).
 *   - 503 (not 401) when env unset — surface looks "off" rather than
 *     "wrong bearer."
 *   - Mounted BEFORE the user-token /admin/* router so the bearer is the
 *     only auth check that runs.
 *
 * Summary aggregation:
 *   - total           — count of rows in the window
 *   - ok_count        — rows where ok=1
 *   - fail_count      — rows where ok=0
 *   - success_rate    — ok_count / total (0..1; 0 when total=0)
 *   - total_tokens_in / total_tokens_out
 *   - modes           — { stub: N, real_llm: N }  (note: hyphen replaced
 *                       with underscore in the JSON key so it round-trips
 *                       cleanly through every dashboard JSON consumer)
 *   - tiers           — { pro: N, team: N }
 */

import { Hono } from "hono";
import { timingSafeEqual, randomUUID } from "crypto";
import { Buffer } from "buffer";
import { logger } from "../lib/logger.js";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestrationRunRow {
  id: number;
  graph_id: string;
  goal: string;
  tier: "pro" | "team";
  mode: "stub" | "real-llm";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  node_count: number;
  fail_count: number;
  ok: number; // 0 | 1 from SQLite
  total_tokens_in: number;
  total_tokens_out: number;
  received_at: string;
}

export interface OrchestrationSummary {
  total: number;
  ok_count: number;
  fail_count: number;
  success_rate: number;
  total_tokens_in: number;
  total_tokens_out: number;
  modes: { stub: number; real_llm: number };
  tiers: { pro: number; team: number };
}

// ---------------------------------------------------------------------------
// Dependency injection seam for testing — mirrors admin-wad-d.ts pattern.
// ---------------------------------------------------------------------------

type ReadRunsFn = (
  days: number,
  limit: number,
) => { runs: OrchestrationRunRow[]; summary: OrchestrationSummary }
  | Promise<{ runs: OrchestrationRunRow[]; summary: OrchestrationSummary }>;

function defaultReadRuns(
  days: number,
  limit: number,
): { runs: OrchestrationRunRow[]; summary: OrchestrationSummary } {
  const db = getDb();

  // Use a unix-epoch comparison so the index works regardless of the
  // received_at default format.
  // SQLite stores CURRENT_TIMESTAMP as "YYYY-MM-DD HH:MM:SS"; we compare via
  // datetime() to keep the window inclusive of the day.
  const horizon = `-${days} days`;

  const runs = db
    .query<OrchestrationRunRow, [string, number]>(
      `SELECT id, graph_id, goal, tier, mode,
              started_at, finished_at, duration_ms,
              node_count, fail_count, ok,
              total_tokens_in, total_tokens_out, received_at
       FROM orchestration_runs
       WHERE received_at >= datetime('now', ?)
       ORDER BY received_at DESC
       LIMIT ?`,
    )
    .all(horizon, limit);

  // Summary is computed across ALL rows in the window (not just LIMIT M),
  // so the headline counts reflect actual activity.
  interface SummaryRow {
    total: number;
    ok_count: number;
    fail_count: number;
    total_tokens_in: number;
    total_tokens_out: number;
    stub_count: number;
    real_llm_count: number;
    pro_count: number;
    team_count: number;
  }
  const aggRow = db
    .query<SummaryRow, [string]>(
      `SELECT
         COUNT(*)                                                  AS total,
         COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0)      AS ok_count,
         COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0)      AS fail_count,
         COALESCE(SUM(total_tokens_in),  0)                        AS total_tokens_in,
         COALESCE(SUM(total_tokens_out), 0)                        AS total_tokens_out,
         COALESCE(SUM(CASE WHEN mode = 'stub'     THEN 1 ELSE 0 END), 0) AS stub_count,
         COALESCE(SUM(CASE WHEN mode = 'real-llm' THEN 1 ELSE 0 END), 0) AS real_llm_count,
         COALESCE(SUM(CASE WHEN tier = 'pro'      THEN 1 ELSE 0 END), 0) AS pro_count,
         COALESCE(SUM(CASE WHEN tier = 'team'     THEN 1 ELSE 0 END), 0) AS team_count
       FROM orchestration_runs
       WHERE received_at >= datetime('now', ?)`,
    )
    .get(horizon);

  const agg: SummaryRow = aggRow ?? {
    total: 0,
    ok_count: 0,
    fail_count: 0,
    total_tokens_in: 0,
    total_tokens_out: 0,
    stub_count: 0,
    real_llm_count: 0,
    pro_count: 0,
    team_count: 0,
  };

  const summary: OrchestrationSummary = {
    total: agg.total,
    ok_count: agg.ok_count,
    fail_count: agg.fail_count,
    success_rate: agg.total > 0 ? agg.ok_count / agg.total : 0,
    total_tokens_in: agg.total_tokens_in,
    total_tokens_out: agg.total_tokens_out,
    modes: { stub: agg.stub_count, real_llm: agg.real_llm_count },
    tiers: { pro: agg.pro_count, team: agg.team_count },
  };

  return { runs, summary };
}

let activeReader: ReadRunsFn = defaultReadRuns;

/** @internal — test-only hook. Pass null to restore the default reader. */
export function _setOrchestrationRunsReader(fn: ReadRunsFn | null): void {
  activeReader = fn ?? defaultReadRuns;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeCompareBearer(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function parseDaysParam(raw: string | undefined): number {
  if (!raw) return DEFAULT_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

function parseLimitParam(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminOrchestrationRuns = new Hono();

adminOrchestrationRuns.get("/admin/orchestration-runs", async (c) => {
  const requestId = randomUUID();
  const expected = process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];

  if (!expected) {
    logger.warn(
      { event: "admin_orchestration_runs_read", requestId, reason: "token_unset" },
      "admin-orchestration-runs: rejected (ASHLR_ADMIN_TRIGGER_TOKEN unset)",
    );
    return c.json(
      { error: "Endpoint disabled (admin trigger token not configured)", requestId },
      503,
    );
  }

  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const provided = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (!safeCompareBearer(provided, expected)) {
    return c.json({ error: "Unauthorized", requestId }, 401);
  }

  const days = parseDaysParam(c.req.query("days"));
  const limit = parseLimitParam(c.req.query("limit"));

  try {
    const { runs, summary } = await activeReader(days, limit);
    return c.json({ runs, summary, requestId });
  } catch (err) {
    logger.error(
      {
        event: "admin_orchestration_runs_read",
        requestId,
        err: err instanceof Error ? err.message : String(err),
        failed: true,
      },
      "admin-orchestration-runs: read failed",
    );
    return c.json({ error: "Read failed", requestId }, 500);
  }
});

export default adminOrchestrationRuns;
