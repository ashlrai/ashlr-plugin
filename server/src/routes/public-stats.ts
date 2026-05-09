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
import { getPublicStats } from "../db/public-stats.js";

const publicStats = new Hono();

publicStats.get("/public/stats", (c) => {
  const stats = getPublicStats();

  c.header("Cache-Control", "public, max-age=60");

  return c.json(stats);
});

export default publicStats;
