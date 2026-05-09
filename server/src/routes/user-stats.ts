/**
 * user-stats.ts — Pro user-tier stats endpoints (Stage 2).
 *
 * All routes require user JWT auth (authMiddleware), NOT requireAdmin.
 * Pro-gated routes additionally call requireTier(c, user, "pro").
 * Team-gated routes additionally check user.tier === "team".
 *
 *   GET /stats/cost-histogram?window=720
 *   GET /stats/genome-growth
 *   GET /stats/cross-machine?window=720
 *   GET /team/:orgId/aggregates   (Pro Team only)
 */

import { Hono } from "hono";
import { authMiddleware, requireTier } from "../lib/auth.js";
import {
  userGetCostPerSessionHistogram,
  userGetGenomeGrowth,
  userGetCrossMachineTimeline,
  teamGetAggregates,
} from "../db/index.js";

const router = new Hono();

// All routes require a valid user token
router.use("/stats/cost-histogram", authMiddleware);
router.use("/stats/genome-growth",  authMiddleware);
router.use("/stats/cross-machine",  authMiddleware);
router.use("/team/:orgId/aggregates", authMiddleware);

// ---------------------------------------------------------------------------
// GET /stats/cost-histogram?window=720
// Returns per-session cost distribution bucketed into $0-1, $1-5, $5-25,
// $25-100, $100+. Pro-gated.
// ---------------------------------------------------------------------------

router.get("/stats/cost-histogram", (c) => {
  const user = c.get("user");
  const deny = requireTier(c, user, "pro");
  if (deny) return deny;

  const windowStr = c.req.query("window");
  const windowHours = windowStr ? Math.max(1, Number(windowStr)) : 720;
  if (!Number.isFinite(windowHours)) {
    return c.json({ error: "Invalid window parameter" }, 400);
  }

  const buckets = userGetCostPerSessionHistogram(user.id, windowHours);
  return c.json({ buckets, window_hours: windowHours });
});

// ---------------------------------------------------------------------------
// GET /stats/genome-growth
// Returns daily genome section_count and total_bytes over all time.
// Pro-gated.
// ---------------------------------------------------------------------------

router.get("/stats/genome-growth", (c) => {
  const user = c.get("user");
  const deny = requireTier(c, user, "pro");
  if (deny) return deny;

  const rows = userGetGenomeGrowth(user.id);
  return c.json({ rows });
});

// ---------------------------------------------------------------------------
// GET /stats/cross-machine?window=720
// Returns per-machine daily token savings within the window.
// Pro-gated.
// ---------------------------------------------------------------------------

router.get("/stats/cross-machine", (c) => {
  const user = c.get("user");
  const deny = requireTier(c, user, "pro");
  if (deny) return deny;

  const windowStr = c.req.query("window");
  const windowHours = windowStr ? Math.max(1, Number(windowStr)) : 720;
  if (!Number.isFinite(windowHours)) {
    return c.json({ error: "Invalid window parameter" }, 400);
  }

  const rows = userGetCrossMachineTimeline(user.id, windowHours);
  return c.json({ rows, window_hours: windowHours });
});

// ---------------------------------------------------------------------------
// GET /team/:orgId/aggregates
// Returns team-wide totals. Requires tier=team AND caller must belong to the
// requested org (user.org_id === orgId). Returns 403 otherwise.
// ---------------------------------------------------------------------------

router.get("/team/:orgId/aggregates", (c) => {
  const user = c.get("user");

  // Must be team tier
  if (user.tier !== "team") {
    return c.json(
      { error: "This feature requires a Pro Team plan.", upgrade_url: "/billing/checkout" },
      403,
    );
  }

  const orgId = c.req.param("orgId");

  // Scope check: caller must belong to the requested org
  if (!user.org_id || user.org_id !== orgId) {
    return c.json({ error: "Access denied — not a member of this org." }, 403);
  }

  const aggregates = teamGetAggregates(orgId);
  return c.json(aggregates);
});

export default router;
