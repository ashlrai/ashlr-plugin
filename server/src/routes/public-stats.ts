/**
 * public-stats.ts — Public aggregate stats endpoint (no auth required).
 *
 * GET /public/stats
 *
 * Returns aggregate numbers safe to expose publicly:
 *   - total_tokens_saved_lifetime
 *   - total_users
 *   - total_dollars_saved
 *   - last_updated_at
 *
 * Privacy: only aggregate counts — never per-user data, emails, or sessions.
 * Caching: backed by a 5-minute in-process cache (db/public-stats.ts).
 *          Also sets Cache-Control: public, max-age=60 for CDN/browser caching.
 */

import { Hono } from "hono";
import { getPublicStats, getPublicTimeSeries, getPublicLeaderboard } from "../db/public-stats.js";

const publicStats = new Hono();

publicStats.get("/public/stats", (c) => {
  const stats = getPublicStats();

  c.header("Cache-Control", "public, max-age=60");

  return c.json(stats);
});

/**
 * GET /public/stats/time-series
 *
 * Global per-day tokens & dollars saved (with running cumulative), for the
 * public savings graph. Aggregate-only — no per-user data. Same cache
 * discipline as /public/stats.
 */
publicStats.get("/public/stats/time-series", (c) => {
  const data = getPublicTimeSeries();

  c.header("Cache-Control", "public, max-age=60");

  return c.json(data);
});

/**
 * GET /public/leaderboard?limit=100
 *
 * Opt-in per-developer ranking by tokens saved (GitHub handle + savings only).
 * Aggregate of opted-in users; no email or other PII. Same cache discipline.
 */
publicStats.get("/public/leaderboard", (c) => {
  // getPublicLeaderboard owns all validation (NaN/0/negative/>100 → clamped).
  const data = getPublicLeaderboard(Number(c.req.query("limit")));

  c.header("Cache-Control", "public, max-age=60");

  return c.json(data);
});

export default publicStats;
