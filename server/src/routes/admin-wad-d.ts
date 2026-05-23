/**
 * admin-wad-d.ts — Founder-only read endpoint for WAD-D history snapshots.
 *
 * Sibling to admin-jobs.ts (which write-triggers the daily aggregator).
 * This file exposes a READ surface so a founder-only Next.js dashboard
 * (site/app/admin/wad-d) can render the last N days of WAD-D values
 * without ever exposing the underlying database to the public internet.
 *
 * Endpoint:
 *   GET /admin/wad-d-snapshots?days=N
 *     Auth:    Authorization: Bearer <ASHLR_ADMIN_TRIGGER_TOKEN>
 *     Query:   days — integer, default 30, capped at 365
 *     200:     { snapshots: [{snapshot_date, wad_d_value, lead_indicators_json, computed_at}, ...] }
 *              Ordered by snapshot_date DESC.
 *     401:     missing/wrong bearer
 *     503:     ASHLR_ADMIN_TRIGGER_TOKEN unset on server
 *
 * Security:
 *   - Bearer compared via `crypto.timingSafeEqual` (after equal-length pad).
 *   - When the env var is unset, returns 503 — never 401 — so a misconfigured
 *     deploy never looks like an auth surface waiting for the right bearer.
 *   - Endpoint is mounted BEFORE the user-token-gated /admin/* router so the
 *     bearer is the only auth check that runs.
 *
 * Why a separate route file (vs extending admin-jobs.ts):
 *   - admin-jobs.ts is conceptually a *write* trigger surface; mixing reads
 *     into it would muddy the contract.
 *   - Tests can mock the data layer here independently.
 */

import { Hono } from "hono";
import { timingSafeEqual, randomUUID } from "crypto";
import { Buffer } from "buffer";
import { logger } from "../lib/logger.js";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Dependency injection seam for testing
// ---------------------------------------------------------------------------
//
// bun:test's `mock.module()` patches the module registry process-wide and
// leaks across test files. Instead we expose a thin setter that the test
// file uses to swap the snapshot reader, and resets it in afterEach.
// Production code uses the default `defaultReadSnapshots` implementation.
// ---------------------------------------------------------------------------

export interface WadDSnapshotRow {
  snapshot_date: string;
  wad_d_value: number;
  lead_indicators_json: string | null;
  computed_at: string;
}

type ReadSnapshots = (days: number) => WadDSnapshotRow[] | Promise<WadDSnapshotRow[]>;

function defaultReadSnapshots(days: number): WadDSnapshotRow[] {
  const db = getDb();
  // Use LIMIT to bound result size; index idx_wad_d_snapshots_snapshot_date_desc
  // covers the ORDER BY so this is O(days) regardless of total table size.
  const rows = db
    .query(
      `SELECT snapshot_date, wad_d_value, lead_indicators_json, computed_at
       FROM wad_d_snapshots
       ORDER BY snapshot_date DESC
       LIMIT ?`,
    )
    .all(days) as WadDSnapshotRow[];
  return rows;
}

let activeReader: ReadSnapshots = defaultReadSnapshots;

/** @internal — test-only hook. Do not call from production code. */
export function _setWadDSnapshotReader(fn: ReadSnapshots | null): void {
  activeReader = fn ?? defaultReadSnapshots;
}

const adminWadD = new Hono();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Constant-time bearer-token comparison. Matches admin-jobs.ts pattern. */
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

/** Parse and clamp the days query param. Returns DEFAULT_DAYS for any
 *  malformed input (NaN, negative, zero, non-integer). Caps at MAX_DAYS. */
function parseDaysParam(raw: string | undefined): number {
  if (!raw) return DEFAULT_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

// ---------------------------------------------------------------------------
// GET /admin/wad-d-snapshots
// ---------------------------------------------------------------------------

adminWadD.get("/admin/wad-d-snapshots", async (c) => {
  const requestId = randomUUID();
  const expected = process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];

  // Surface off when token unset — return 503, NOT 401.
  if (!expected) {
    logger.warn(
      { event: "admin_wad_d_read", requestId, reason: "token_unset" },
      "admin-wad-d: rejected (ASHLR_ADMIN_TRIGGER_TOKEN unset)",
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

  try {
    const snapshots = await activeReader(days);
    return c.json({ snapshots, requestId });
  } catch (err) {
    logger.error(
      {
        event: "admin_wad_d_read",
        requestId,
        err: err instanceof Error ? err.message : String(err),
        failed: true,
      },
      "admin-wad-d: read failed",
    );
    return c.json({ error: "Read failed", requestId }, 500);
  }
});

export default adminWadD;
