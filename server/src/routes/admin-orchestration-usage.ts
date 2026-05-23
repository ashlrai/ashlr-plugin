/**
 * admin-orchestration-usage.ts — Founder-only read endpoint for
 * orchestration_usage (the central-quota accounting table).
 *
 * Sibling to admin-orchestration-runs.ts (the raw-events read) and
 * admin-wad-d.ts (WAD-D snapshots).
 *
 * Endpoint:
 *   GET /admin/orchestration-usage?month=YYYY-MM&top=N
 *     Auth:    Authorization: Bearer <ASHLR_ADMIN_TRIGGER_TOKEN>
 *     Query:   month — ISO month YYYY-MM. Defaults to current UTC month.
 *              top   — int, default 50, capped at 500.
 *     200:     {
 *                month: "YYYY-MM",
 *                buckets: [{
 *                  team_bucket, graphs_run, agents_spawned,
 *                  tokens_in, tokens_out,
 *                  percent_of_cap, throttle_state,
 *                }, ...]
 *              }
 *              Ordered by graphs_run DESC.
 *     400:     malformed `month` (non YYYY-MM)
 *     401:     missing/wrong bearer
 *     503:     ASHLR_ADMIN_TRIGGER_TOKEN env unset on server
 *
 * Quota model:
 *   - per-seat monthly cap = 200 graph-runs.
 *   - percent_of_cap       = graphs_run / 200
 *   - throttle_state:
 *       percent_of_cap <  0.80 -> "ok"
 *       percent_of_cap <  1.00 -> "warn"    (soft throttle at 80%)
 *       percent_of_cap >= 1.00 -> "throttled"
 *
 * Note: this endpoint is *accounting only*. No enforcement happens here —
 * the cloud-orchestration executor (wk 7-12) will read percent_of_cap at
 * dispatch time and refuse runs in "throttled" state.
 *
 * Security mirrors admin-wad-d.ts:
 *   - timingSafeEqual bearer compare (constant time).
 *   - 503 (not 401) when env unset — surface looks "off" rather than
 *     "wrong bearer."
 *   - Mounted BEFORE the user-token /admin/* router so the bearer is the
 *     only auth check that runs.
 */

import { Hono } from "hono";
import { timingSafeEqual, randomUUID } from "crypto";
import { Buffer } from "buffer";
import { logger } from "../lib/logger.js";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-seat monthly cap on graph-runs. Defined in issue #84. */
export const MONTHLY_GRAPH_CAP = 200;

/** Soft-throttle threshold — emit "warn" once the bucket crosses 80% of cap. */
export const SOFT_THROTTLE_RATIO = 0.8;

const DEFAULT_TOP = 50;
const MAX_TOP = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThrottleState = "ok" | "warn" | "throttled";

export interface UsageBucketRow {
  team_bucket: string;
  graphs_run: number;
  agents_spawned: number;
  tokens_in: number;
  tokens_out: number;
}

export interface UsageBucket extends UsageBucketRow {
  percent_of_cap: number;
  throttle_state: ThrottleState;
}

// ---------------------------------------------------------------------------
// Dependency injection seam for testing — mirrors admin-wad-d.ts pattern.
// ---------------------------------------------------------------------------

type ReadUsageFn = (
  month: string,
  top: number,
) => UsageBucketRow[] | Promise<UsageBucketRow[]>;

function defaultReadUsage(month: string, top: number): UsageBucketRow[] {
  const db = getDb();
  return db
    .query<UsageBucketRow, [string, number]>(
      `SELECT team_bucket, graphs_run, agents_spawned,
              tokens_in, tokens_out
       FROM orchestration_usage
       WHERE month_key = ?
       ORDER BY graphs_run DESC
       LIMIT ?`,
    )
    .all(month, top);
}

let activeReader: ReadUsageFn = defaultReadUsage;

/** @internal — test-only hook. Pass null to restore the default reader. */
export function _setOrchestrationUsageReader(fn: ReadUsageFn | null): void {
  activeReader = fn ?? defaultReadUsage;
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

/** Current month in UTC as YYYY-MM. */
export function currentMonthUtc(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

/**
 * Strict ISO YYYY-MM validator. Rejects partial inputs and bad months
 * (e.g. 2026-13). Returns the canonical "YYYY-MM" on success.
 */
export function parseMonthParam(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return currentMonthUtc();
  if (!/^\d{4}-\d{2}$/.test(raw)) return null;
  const month = Number.parseInt(raw.slice(5), 10);
  if (month < 1 || month > 12) return null;
  return raw;
}

function parseTopParam(raw: string | undefined): number {
  if (!raw) return DEFAULT_TOP;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP;
  return Math.min(n, MAX_TOP);
}

/** Compute throttle_state from graphs_run against the monthly cap. */
export function deriveThrottleState(graphsRun: number): {
  percent_of_cap: number;
  throttle_state: ThrottleState;
} {
  const pct = graphsRun / MONTHLY_GRAPH_CAP;
  // Round percent_of_cap to 3 decimals so JSON round-trips cleanly.
  const percent_of_cap = Math.round(pct * 1000) / 1000;
  let throttle_state: ThrottleState;
  if (percent_of_cap >= 1.0) throttle_state = "throttled";
  else if (percent_of_cap >= SOFT_THROTTLE_RATIO) throttle_state = "warn";
  else throttle_state = "ok";
  return { percent_of_cap, throttle_state };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminOrchestrationUsage = new Hono();

adminOrchestrationUsage.get("/admin/orchestration-usage", async (c) => {
  const requestId = randomUUID();
  const expected = process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];

  if (!expected) {
    logger.warn(
      { event: "admin_orchestration_usage_read", requestId, reason: "token_unset" },
      "admin-orchestration-usage: rejected (ASHLR_ADMIN_TRIGGER_TOKEN unset)",
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

  const month = parseMonthParam(c.req.query("month"));
  if (month === null) {
    return c.json(
      { error: "Invalid month (expected YYYY-MM)", requestId },
      400,
    );
  }
  const top = parseTopParam(c.req.query("top"));

  try {
    const rows = await activeReader(month, top);
    const buckets: UsageBucket[] = rows.map((r) => ({
      ...r,
      ...deriveThrottleState(r.graphs_run),
    }));
    return c.json({ month, buckets, requestId });
  } catch (err) {
    logger.error(
      {
        event: "admin_orchestration_usage_read",
        requestId,
        err: err instanceof Error ? err.message : String(err),
        failed: true,
      },
      "admin-orchestration-usage: read failed",
    );
    return c.json({ error: "Read failed", requestId }, 500);
  }
});

export default adminOrchestrationUsage;
