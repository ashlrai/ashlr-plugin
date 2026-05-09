/**
 * db/public-stats.ts — Aggregate stats for the public marketing counter.
 *
 * Privacy invariant: returns only aggregate counts — no per-user fields,
 * no emails, no sessions, nothing identifying.
 *
 * Caching: results are memoised for CACHE_TTL_MS (5 minutes) in process
 * memory. Landing-page traffic hits the cache; the DB query runs at most
 * once per 5 minutes.
 */

import { getDb } from "./connection";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PublicStats {
  total_tokens_saved_lifetime: number;
  total_users: number;
  total_dollars_saved: number;
  last_updated_at: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Pricing (sonnet-4.5 input rate — same as svg.ts / badge)
// ---------------------------------------------------------------------------

/** Cost in USD per token saved (sonnet-4.5 input: $3.00 / 1M tokens). */
const DOLLARS_PER_TOKEN = 3.0 / 1_000_000;

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

interface CacheEntry {
  data: PublicStats;
  expiresAt: number;
}

let _cache: CacheEntry | null = null;

/** Exposed only for tests — resets the in-process cache. */
export function _resetPublicStatsCache(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Returns aggregate public stats.
 *
 * The query is cheap: two simple aggregates with no JOINs.
 *   - SUM(lifetime_tokens_saved) across the latest upload per user
 *     (MAX per user, then SUM globally — avoids double-counting multi-machine
 *     users whose lifetime counter is cumulative per device).
 *   - COUNT(*) of users table.
 *
 * Results are cached in-process for CACHE_TTL_MS.
 */
export function getPublicStats(): PublicStats {
  const now = Date.now();

  // Serve from cache if fresh
  if (_cache && now < _cache.expiresAt) {
    return _cache.data;
  }

  const db = getDb();

  // Sum of the highest lifetime_tokens_saved per user across all uploads.
  // This avoids inflating the number when a user syncs from multiple machines
  // (each machine reports its own cumulative counter independently).
  const tokensRow = db
    .query<{ total: number }, []>(
      `SELECT COALESCE(SUM(max_tokens), 0) AS total
       FROM (
         SELECT MAX(lifetime_tokens_saved) AS max_tokens
         FROM stats_uploads
         GROUP BY user_id
       )`,
    )
    .get();

  const usersRow = db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM users`)
    .get();

  const totalTokens = tokensRow?.total ?? 0;
  const totalUsers  = usersRow?.n ?? 0;
  const totalDollars = Math.round(totalTokens * DOLLARS_PER_TOKEN * 100) / 100;

  const data: PublicStats = {
    total_tokens_saved_lifetime: totalTokens,
    total_users:                 totalUsers,
    total_dollars_saved:         totalDollars,
    last_updated_at:             new Date().toISOString(),
  };

  _cache = { data, expiresAt: now + CACHE_TTL_MS };
  return data;
}
