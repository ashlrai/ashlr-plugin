/**
 * badge.ts — Hosted badge service.
 *
 * GET /u/:userId/badge.svg?metric=tokens|dollars|calls&style=pill|flat|card
 *
 * Sources the badge from the user's latest stats_upload. Falls back to a
 * "no data yet" badge if the user has no uploads. No auth required — badges
 * are public by design.
 */

import { Hono } from "hono";
import { getUserById, getLatestUpload } from "../db.js";
import { generateBadgeSvg, type Metric, type Style, type BadgeData } from "../lib/svg.js";

const badge = new Hono();

badge.get("/u/:userId/badge.svg", (c) => {
  const { userId } = c.req.param();

  // Validate + coerce query params
  const rawMetric = c.req.query("metric") ?? "tokens";
  const rawStyle  = c.req.query("style")  ?? "pill";

  const metric: Metric = (["tokens", "dollars", "calls"] as const).includes(rawMetric as Metric)
    ? (rawMetric as Metric)
    : "tokens";
  const style: Style   = (["pill", "flat", "card"] as const).includes(rawStyle as Style)
    ? (rawStyle as Style)
    : "pill";

  // Look up user + latest upload
  const user   = getUserById(userId);
  const upload = user ? getLatestUpload(userId) : null;

  let data: BadgeData | null = null;
  if (upload) {
    let byDay: Record<string, number> = {};
    try {
      const raw = JSON.parse(upload.by_day_json) as Record<string, unknown>;
      // by_day_json may be { "YYYY-MM-DD": { tokensSaved: N } } or { "YYYY-MM-DD": N }
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "number") {
          byDay[k] = v;
        } else if (typeof v === "object" && v !== null && "tokensSaved" in v) {
          byDay[k] = (v as { tokensSaved: number }).tokensSaved;
        }
      }
    } catch { /* malformed — byDay stays empty */ }

    data = {
      tokens: upload.lifetime_tokens_saved,
      calls:  upload.lifetime_calls,
      byDay,
    };
  }

  const svg = generateBadgeSvg(data, { metric, style });

  return new Response(svg, {
    headers: {
      "Content-Type":  "image/svg+xml",
      "Cache-Control": "public, max-age=300",
    },
  });
});

export default badge;
