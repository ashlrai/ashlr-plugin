/**
 * admin-sessions.ts — Founder-only read endpoint for the Q4 session graph
 * replay UI (READ side of the Q4 Multiplayer DNA "session graph" surface).
 *
 * Siblings:
 *   - admin-wad-d.ts          (WAD-D history reads)
 *   - admin-wad-d-breakdown.ts (segment breakdown reads)
 *   - session-events.ts        (POST capture endpoint — PR #79)
 *
 * Endpoints:
 *   GET /admin/sessions?days=N&limit=M&logged_in=true|false
 *     Auth:    Authorization: Bearer <ASHLR_ADMIN_TRIGGER_TOKEN>
 *     Query:
 *       days       — integer, default 7, capped at 90
 *       limit      — integer, default 50, capped at 200
 *       logged_in  — optional "true" => github_hash IS NOT NULL
 *                                "false" => github_hash IS NULL
 *                                omitted => no filter
 *     200:     {
 *                sessions: [{
 *                  session_id_hash, identity_hash_prefix, github_hash_prefix,
 *                  ended_at, tool_count, tokens_saved, branch_sha,
 *                  discovery_refs
 *                }, ...],
 *                total_count_in_window,
 *                requestId
 *              }
 *     401:     missing/wrong bearer
 *     503:     ASHLR_ADMIN_TRIGGER_TOKEN unset on server
 *
 *   GET /admin/sessions/:session_id_hash
 *     Auth:    Authorization: Bearer <ASHLR_ADMIN_TRIGGER_TOKEN>
 *     200:     {
 *                session: { ...detail fields },
 *                related: [{ ...other sessions by same identity_hash, last 30d }],
 *                requestId
 *              }
 *     404:     unknown session_id_hash (NOT 403 — don't leak existence)
 *     401:     missing/wrong bearer
 *     503:     ASHLR_ADMIN_TRIGGER_TOKEN unset on server
 *
 * Privacy:
 *   - The UI ONLY ever sees HASH PREFIXES (first 8 chars). Raw identity_hash
 *     and full session_id_hash never reach the wire response — except the
 *     session_id_hash that the caller already supplied (so they can deep-link
 *     into the detail page). The point of session_events is that they're
 *     anonymous; this read surface preserves that.
 *   - discovery_refs are opaque section IDs the client already chose to send.
 *     Safe to echo back as-is (mirrors session-events.ts intake).
 *   - We DO NOT leak the existence of a session_id_hash on the detail route:
 *     unknown id => 404, same shape as a typo.
 *
 * Security:
 *   - Bearer compared via `crypto.timingSafeEqual` (after equal-length pad).
 *   - When env var unset, returns 503 — never 401 — so a misconfigured deploy
 *     never looks like an auth surface. Same precedent as admin-wad-d.ts.
 *   - Endpoint mounted BEFORE the user-token-gated /admin/* router (matches
 *     the PR #67 / PR #73 / PR #74 pattern).
 *
 * Why a separate route file (vs extending admin-wad-d.ts):
 *   - WAD-D reads are aggregates by date; session reads are per-row events
 *     with per-identity "related" lookups. Different contract, different
 *     test surface.
 */

import { Hono, type Context } from "hono";
import { timingSafeEqual, randomUUID } from "crypto";
import { Buffer } from "buffer";
import { logger } from "../lib/logger.js";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Row + response types
// ---------------------------------------------------------------------------

export interface SessionEventRow {
  session_id_hash: string;
  identity_hash: string;
  github_hash: string | null;
  ended_at: string;
  tool_count: number;
  tokens_saved: number;
  branch_sha: string | null;
  discovery_refs_json: string;
}

export interface SessionListEntry {
  session_id_hash: string;
  identity_hash_prefix: string;
  github_hash_prefix: string | null;
  ended_at: string;
  tool_count: number;
  tokens_saved: number;
  branch_sha: string | null;
  discovery_refs: string[];
}

// ---------------------------------------------------------------------------
// Dependency-injection seam for testing
// ---------------------------------------------------------------------------
//
// Matches the admin-wad-d.ts pattern. Tests swap in a fake reader; production
// uses the SQLite-backed defaults.
// ---------------------------------------------------------------------------

export interface ListFilter {
  days: number;
  limit: number;
  loggedIn: boolean | null; // null = no filter
}

type ListReader = (
  filter: ListFilter,
) => { sessions: SessionEventRow[]; total: number } | Promise<{ sessions: SessionEventRow[]; total: number }>;

type DetailReader = (
  sessionIdHash: string,
) => SessionEventRow | null | Promise<SessionEventRow | null>;

type RelatedReader = (
  identityHash: string,
  excludeSessionIdHash: string,
  days: number,
) => SessionEventRow[] | Promise<SessionEventRow[]>;

function defaultListReader(
  filter: ListFilter,
): { sessions: SessionEventRow[]; total: number } {
  const db = getDb();

  // Window is "ended_at within the last N days." We use UTC ISO comparison
  // since session_events.ended_at is stored as an ISO string.
  const cutoffMs = Date.now() - filter.days * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Build the predicate. We hand-build with parameter binding (no SQL
  // string concatenation of user input) — `loggedIn` is a closed enum.
  let whereClause = `ended_at >= ?`;
  const params: (string | number)[] = [cutoffIso];

  if (filter.loggedIn === true) {
    whereClause += ` AND github_hash IS NOT NULL`;
  } else if (filter.loggedIn === false) {
    whereClause += ` AND github_hash IS NULL`;
  }

  const sessions = db
    .query(
      `SELECT session_id_hash, identity_hash, github_hash, ended_at,
              tool_count, tokens_saved, branch_sha, discovery_refs_json
       FROM session_events
       WHERE ${whereClause}
       ORDER BY ended_at DESC
       LIMIT ?`,
    )
    .all(...params, filter.limit) as SessionEventRow[];

  const total = (db
    .query(`SELECT COUNT(*) AS n FROM session_events WHERE ${whereClause}`)
    .get(...params) as { n: number } | undefined)?.n ?? 0;

  return { sessions, total };
}

function defaultDetailReader(sessionIdHash: string): SessionEventRow | null {
  const db = getDb();
  const row = db
    .query(
      `SELECT session_id_hash, identity_hash, github_hash, ended_at,
              tool_count, tokens_saved, branch_sha, discovery_refs_json
       FROM session_events
       WHERE session_id_hash = ?
       LIMIT 1`,
    )
    .get(sessionIdHash) as SessionEventRow | undefined;
  return row ?? null;
}

function defaultRelatedReader(
  identityHash: string,
  excludeSessionIdHash: string,
  days: number,
): SessionEventRow[] {
  const db = getDb();
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const rows = db
    .query(
      `SELECT session_id_hash, identity_hash, github_hash, ended_at,
              tool_count, tokens_saved, branch_sha, discovery_refs_json
       FROM session_events
       WHERE identity_hash = ?
         AND session_id_hash != ?
         AND ended_at >= ?
       ORDER BY ended_at DESC
       LIMIT 50`,
    )
    .all(identityHash, excludeSessionIdHash, cutoffIso) as SessionEventRow[];
  return rows;
}

let activeListReader: ListReader = defaultListReader;
let activeDetailReader: DetailReader = defaultDetailReader;
let activeRelatedReader: RelatedReader = defaultRelatedReader;

/** @internal — test-only. Pass null to restore the production default. */
export function _setSessionListReader(fn: ListReader | null): void {
  activeListReader = fn ?? defaultListReader;
}
/** @internal — test-only. Pass null to restore the production default. */
export function _setSessionDetailReader(fn: DetailReader | null): void {
  activeDetailReader = fn ?? defaultDetailReader;
}
/** @internal — test-only. Pass null to restore the production default. */
export function _setSessionRelatedReader(fn: RelatedReader | null): void {
  activeRelatedReader = fn ?? defaultRelatedReader;
}

// ---------------------------------------------------------------------------
// Router + helpers
// ---------------------------------------------------------------------------

const adminSessions = new Hono();

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const RELATED_WINDOW_DAYS = 30;

/** Constant-time bearer-token comparison. Matches admin-wad-d.ts. */
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

function parseDaysParam(raw: string | undefined, def: number, max: number): number {
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

function parseLimitParam(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseLoggedIn(raw: string | undefined): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

function parseDiscoveryRefs(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

function toListEntry(row: SessionEventRow): SessionListEntry {
  return {
    session_id_hash: row.session_id_hash,
    identity_hash_prefix: row.identity_hash.slice(0, 8),
    github_hash_prefix: row.github_hash ? row.github_hash.slice(0, 8) : null,
    ended_at: row.ended_at,
    tool_count: row.tool_count,
    tokens_saved: row.tokens_saved,
    branch_sha: row.branch_sha,
    discovery_refs: parseDiscoveryRefs(row.discovery_refs_json),
  };
}

/**
 * Bearer-auth precheck. Returns either:
 *   - a Response (already serialized) to short-circuit, or
 *   - null to signal "auth passed, proceed."
 */
function authPrecheck(
  c: Context,
  requestId: string,
): Response | null {
  const expected = process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
  if (!expected) {
    logger.warn(
      { event: "admin_sessions_read", requestId, reason: "token_unset" },
      "admin-sessions: rejected (ASHLR_ADMIN_TRIGGER_TOKEN unset)",
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
  return null;
}

// ---------------------------------------------------------------------------
// GET /admin/sessions
// ---------------------------------------------------------------------------

adminSessions.get("/admin/sessions", async (c) => {
  const requestId = randomUUID();
  const denied = authPrecheck(c, requestId);
  if (denied) return denied;

  const days = parseDaysParam(c.req.query("days"), DEFAULT_DAYS, MAX_DAYS);
  const limit = parseLimitParam(c.req.query("limit"));
  const loggedIn = parseLoggedIn(c.req.query("logged_in"));

  try {
    const { sessions, total } = await activeListReader({ days, limit, loggedIn });
    return c.json({
      sessions: sessions.map(toListEntry),
      total_count_in_window: total,
      requestId,
    });
  } catch (err) {
    logger.error(
      {
        event: "admin_sessions_read",
        requestId,
        err: err instanceof Error ? err.message : String(err),
        failed: true,
      },
      "admin-sessions: list failed",
    );
    return c.json({ error: "Read failed", requestId }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/sessions/:session_id_hash
// ---------------------------------------------------------------------------

adminSessions.get("/admin/sessions/:session_id_hash", async (c) => {
  const requestId = randomUUID();
  const denied = authPrecheck(c, requestId);
  if (denied) return denied;

  const sessionIdHash = c.req.param("session_id_hash");

  // Cheap sanity check — must look like a sha256 hex hash. If it doesn't, we
  // treat it as unknown (404) rather than echoing a 400 that would tell a
  // scraper "this path validates input shape."
  if (!sessionIdHash || !/^[0-9a-f]{64}$/i.test(sessionIdHash)) {
    return c.json({ error: "Not found", requestId }, 404);
  }

  try {
    const row = await activeDetailReader(sessionIdHash);
    if (!row) {
      return c.json({ error: "Not found", requestId }, 404);
    }
    const related = await activeRelatedReader(
      row.identity_hash,
      row.session_id_hash,
      RELATED_WINDOW_DAYS,
    );
    return c.json({
      session: toListEntry(row),
      related: related.map(toListEntry),
      requestId,
    });
  } catch (err) {
    logger.error(
      {
        event: "admin_sessions_read",
        requestId,
        err: err instanceof Error ? err.message : String(err),
        failed: true,
      },
      "admin-sessions: detail failed",
    );
    return c.json({ error: "Read failed", requestId }, 500);
  }
});

export default adminSessions;
