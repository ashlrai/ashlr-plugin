/**
 * admin-discovery-propagation.ts — Founder-only read endpoint for
 * cross-session discovery propagation stats.
 *
 * Sibling to admin-wad-d.ts. Reads from discovery_propagation_stats which
 * is populated by jobs/discovery-propagation-aggregate.ts (invoked from the
 * daily WAD-D cron).
 *
 * Endpoint:
 *   GET /admin/discoveries/propagation?limit=N&sort=session_count|distinct_identity_count|recent
 *     Auth:    Authorization: Bearer <ASHLR_ADMIN_TRIGGER_TOKEN>
 *     Query:
 *       limit  — integer, default 50, capped at 500
 *       sort   — "session_count" (default) | "distinct_identity_count" | "recent"
 *                  - session_count           -> ORDER BY session_count DESC
 *                  - distinct_identity_count -> ORDER BY distinct_identity_count DESC
 *                  - recent                  -> ORDER BY last_seen_at DESC
 *     200:     { discoveries: [...], requestId }
 *     401:     missing/wrong bearer
 *     503:     ASHLR_ADMIN_TRIGGER_TOKEN unset on server
 *
 * Security:
 *   - Bearer compared via `crypto.timingSafeEqual` (after equal-length pad).
 *   - When the env var is unset, returns 503 — never 401.
 *   - Mounted BEFORE the user-token-gated /admin/* router so the bearer is
 *     the only auth check that runs.
 *
 * Privacy:
 *   - Response payload carries only aggregate counts (session_count,
 *     distinct_identity_count) and aggregate timestamps. NEVER any
 *     identity_hash, session_id_hash, or other raw identifier.
 */

import { Hono } from "hono";
import { timingSafeEqual, randomUUID } from "crypto";
import { Buffer } from "buffer";
import { logger } from "../lib/logger.js";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Dependency injection seam for testing
// ---------------------------------------------------------------------------

export interface DiscoveryPropagationRow {
  discovery_id: string;
  first_seen_at: string;
  last_seen_at: string;
  session_count: number;
  distinct_identity_count: number;
  last_aggregated_at: string;
}

export type SortKey = "session_count" | "distinct_identity_count" | "recent";

type ReadDiscoveries = (
  limit: number,
  sort: SortKey,
) => DiscoveryPropagationRow[] | Promise<DiscoveryPropagationRow[]>;

function defaultReadDiscoveries(
  limit: number,
  sort: SortKey,
): DiscoveryPropagationRow[] {
  const db = getDb();
  // ORDER BY column is whitelisted by parseSortParam, so the string
  // interpolation below is safe — never user-controlled freeform input.
  const orderColumn =
    sort === "recent"
      ? "last_seen_at"
      : sort === "distinct_identity_count"
        ? "distinct_identity_count"
        : "session_count";
  const rows = db
    .query(
      `SELECT discovery_id, first_seen_at, last_seen_at,
              session_count, distinct_identity_count, last_aggregated_at
       FROM discovery_propagation_stats
       ORDER BY ${orderColumn} DESC
       LIMIT ?`,
    )
    .all(limit) as DiscoveryPropagationRow[];
  return rows;
}

let activeReader: ReadDiscoveries = defaultReadDiscoveries;

/** @internal — test-only hook. Do not call from production code. */
export function _setDiscoveryPropagationReader(
  fn: ReadDiscoveries | null,
): void {
  activeReader = fn ?? defaultReadDiscoveries;
}

const adminDiscoveryPropagation = new Hono();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const VALID_SORTS: readonly SortKey[] = [
  "session_count",
  "distinct_identity_count",
  "recent",
];

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

/** Parse + clamp the limit. Falls back to DEFAULT_LIMIT for invalid input. */
function parseLimitParam(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** Whitelist sort key; defaults to "session_count" for anything else. */
function parseSortParam(raw: string | undefined): SortKey {
  if (!raw) return "session_count";
  if ((VALID_SORTS as readonly string[]).includes(raw)) {
    return raw as SortKey;
  }
  return "session_count";
}

// ---------------------------------------------------------------------------
// GET /admin/discoveries/propagation
// ---------------------------------------------------------------------------

adminDiscoveryPropagation.get("/admin/discoveries/propagation", async (c) => {
  const requestId = randomUUID();
  const expected = process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];

  if (!expected) {
    logger.warn(
      { event: "admin_discovery_propagation_read", requestId, reason: "token_unset" },
      "admin-discovery-propagation: rejected (ASHLR_ADMIN_TRIGGER_TOKEN unset)",
    );
    return c.json(
      { error: "Endpoint disabled (admin trigger token not configured)", requestId },
      503,
    );
  }

  const authHeader =
    c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const provided = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (!safeCompareBearer(provided, expected)) {
    return c.json({ error: "Unauthorized", requestId }, 401);
  }

  const limit = parseLimitParam(c.req.query("limit"));
  const sort = parseSortParam(c.req.query("sort"));

  try {
    const discoveries = await activeReader(limit, sort);
    return c.json({ discoveries, requestId });
  } catch (err) {
    logger.error(
      {
        event: "admin_discovery_propagation_read",
        requestId,
        err: err instanceof Error ? err.message : String(err),
        failed: true,
      },
      "admin-discovery-propagation: read failed",
    );
    return c.json({ error: "Read failed", requestId }, 500);
  }
});

export default adminDiscoveryPropagation;
