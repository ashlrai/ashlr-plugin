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

// ---------------------------------------------------------------------------
// Time series — global daily savings (for the public savings graph)
// ---------------------------------------------------------------------------

export interface TimeSeriesPoint {
  date: string; // "YYYY-MM-DD"
  tokens_saved: number;
  dollars_saved: number;
  cumulative_tokens_saved: number;
  cumulative_dollars_saved: number;
}

export interface PublicTimeSeries {
  series: TimeSeriesPoint[];
  last_updated_at: string; // ISO 8601
}

interface TimeSeriesCacheEntry {
  data: PublicTimeSeries;
  expiresAt: number;
}

let _tsCache: TimeSeriesCacheEntry | null = null;

/** Exposed only for tests — resets the time-series cache. */
export function _resetPublicTimeSeriesCache(): void {
  _tsCache = null;
}

/** Round a USD amount to cents. */
function toCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * Per-day global tokens (and dollars) saved, plus a running cumulative total.
 *
 * Privacy: aggregate-only — no user is identifiable in the output.
 *
 * Uses the LATEST upload per user (window function) so a user who syncs many
 * times — or from several machines — contributes their by-day history exactly
 * once. Each user's by_day_json maps "YYYY-MM-DD" → tokens saved that day; we
 * sum across users per day, sort ascending, and accumulate.
 *
 * Cached in-process for CACHE_TTL_MS, same discipline as getPublicStats().
 */
export function getPublicTimeSeries(): PublicTimeSeries {
  const now = Date.now();
  if (_tsCache && now < _tsCache.expiresAt) return _tsCache.data;

  const db = getDb();

  // Latest upload row per user (one row each — avoids multi-sync double-count).
  const rows = db
    .query<{ by_day_json: string }, []>(
      `SELECT by_day_json FROM (
         SELECT by_day_json,
                ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY uploaded_at DESC, id DESC) AS rn
         FROM stats_uploads
       ) WHERE rn = 1`,
    )
    .all();

  // Accumulate tokens per day across all users.
  const perDay = new Map<string, number>();
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.by_day_json || "{}");
    } catch {
      continue; // skip malformed rows
    }
    if (!parsed || typeof parsed !== "object") continue;
    for (const [day, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      // Sync payload stores a number; tolerate a { tokensSaved } shape too.
      let tokens = 0;
      if (typeof val === "number") {
        tokens = val;
      } else if (
        val &&
        typeof val === "object" &&
        typeof (val as { tokensSaved?: unknown }).tokensSaved === "number"
      ) {
        tokens = (val as { tokensSaved: number }).tokensSaved;
      }
      if (!Number.isFinite(tokens) || tokens <= 0) continue;
      perDay.set(day, (perDay.get(day) ?? 0) + tokens);
    }
  }

  const days = [...perDay.keys()].sort();
  let cumTokens = 0;
  const series: TimeSeriesPoint[] = days.map((date) => {
    const tokens = perDay.get(date) ?? 0;
    cumTokens += tokens;
    return {
      date,
      tokens_saved: tokens,
      dollars_saved: toCents(tokens * DOLLARS_PER_TOKEN),
      cumulative_tokens_saved: cumTokens,
      cumulative_dollars_saved: toCents(cumTokens * DOLLARS_PER_TOKEN),
    };
  });

  const data: PublicTimeSeries = {
    series,
    last_updated_at: new Date().toISOString(),
  };
  _tsCache = { data, expiresAt: now + CACHE_TTL_MS };
  return data;
}
