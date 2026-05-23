/**
 * daily-active.ts — WAD-D (Weekly Active Developers — Daily) ingest endpoint.
 *
 * POST /stats/daily-active
 *
 * ---------------------------------------------------------------------------
 * PRIVACY
 * ---------------------------------------------------------------------------
 *   This endpoint is INTENTIONALLY unauthenticated. The body carries a stable,
 *   one-way sha256 hash derived client-side from a local salt — never a
 *   user id, email, machine id, file path, or repo path. The server cannot
 *   reverse identity_hash back to a real developer.
 *
 *   - identity_hash: 64-char lowercase hex sha256 digest from anonymous salt.
 *     We use it solely to count distinct developers per day.
 *   - github_hash:   OPTIONAL second sha256 (same shape) derived from the
 *     user's GitHub login when present, so one developer using multiple
 *     machines is counted once. Still one-way; we don't reverse it.
 *   - plugin_version: harmless string, used only for cohort reporting.
 *
 *   The server NEVER logs the raw identity_hash to user-readable logs. If
 *   logged at all (sampled error path), only the first 6 chars are emitted
 *   so two records from the same developer can be cross-referenced inside
 *   a single debug session without exposing the hash in shipped log dumps.
 *
 *   WAD-D aggregates are founder-only — never surfaced to end users or per
 *   user-id-visible UIs. The aggregator (server/src/jobs/daily-wad-d-aggregate.ts)
 *   writes one row per UTC day into wad_d_snapshots.
 *
 *   Salt rotation: the client is expected to rotate its local salt on a long
 *   cadence (>= 1 year) so the hash space drifts gracefully without breaking
 *   weekly active counts. Server has no role here — it just sees the digest.
 * ---------------------------------------------------------------------------
 */

import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// Lead-indicator block — all fields optional + nullable so older clients
// that omit the block keep posting valid payloads (backward compat).
const LeadIndicatorsSchema = z.object({
  onboarding_completed:           z.boolean().optional(),
  status_line_enabled:            z.boolean().optional(),
  first_savings_at:               z.string().regex(ISO_TS).nullable().optional(),
  streak_days:                    z.number().int().min(0).max(10_000).optional(),
  savings_invocations_this_week:  z.number().int().min(0).max(1_000_000).optional(),
  nudge_accept_rate:              z.number().min(0).max(1).nullable().optional(),
}).strict();

const BodySchema = z.object({
  identity_hash:    z.string().regex(HEX64, "identity_hash must be 64 lowercase hex chars"),
  github_hash:      z.string().regex(HEX64).nullable().optional(),
  date:             z.string().regex(ISO_DATE, "date must be YYYY-MM-DD"),
  plugin_version:   z.string().min(1).max(64),
  lead_indicators:  LeadIndicatorsSchema.optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono();

router.post("/stats/daily-active", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", issues: parsed.error.issues },
      400,
    );
  }

  const { identity_hash, github_hash, date, plugin_version, lead_indicators } = parsed.data;
  const li = lead_indicators ?? {};

  // Idempotent insert — duplicates for same (identity_hash, active_date) are
  // dropped silently. This is the upsert behavior the client relies on for
  // the daily heartbeat retry path.
  //
  // Lead-indicator fields: when the client posts again the same day with
  // refreshed values (e.g. onboarding flipped from false to true after the
  // user finished /ashlr-start mid-day), we want the LATEST values to win.
  // Use ON CONFLICT DO UPDATE for the indicator columns; identity/date stay
  // pinned to their first-seen values.
  //
  // Privacy: indicator values are aggregates only (booleans / counts / one
  // ISO timestamp). The server never logs them with the identity_hash —
  // only with the 6-char prefix on the error path, and only as opaque
  // values.
  try {
    getDb().run(
      `INSERT INTO daily_active_records
         (identity_hash, github_hash, active_date, plugin_version,
          onboarding_completed, status_line_enabled, first_savings_at,
          streak_days, savings_invocations_this_week, nudge_accept_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (identity_hash, active_date) DO UPDATE SET
         onboarding_completed          = COALESCE(excluded.onboarding_completed,          onboarding_completed),
         status_line_enabled           = COALESCE(excluded.status_line_enabled,           status_line_enabled),
         first_savings_at              = COALESCE(excluded.first_savings_at,              first_savings_at),
         streak_days                   = COALESCE(excluded.streak_days,                   streak_days),
         savings_invocations_this_week = COALESCE(excluded.savings_invocations_this_week, savings_invocations_this_week),
         nudge_accept_rate             = COALESCE(excluded.nudge_accept_rate,             nudge_accept_rate)`,
      [
        identity_hash,
        github_hash ?? null,
        date,
        plugin_version,
        typeof li.onboarding_completed === "boolean"            ? (li.onboarding_completed ? 1 : 0) : null,
        typeof li.status_line_enabled === "boolean"             ? (li.status_line_enabled  ? 1 : 0) : null,
        li.first_savings_at === undefined                       ? null : li.first_savings_at,
        typeof li.streak_days === "number"                      ? li.streak_days : null,
        typeof li.savings_invocations_this_week === "number"    ? li.savings_invocations_this_week : null,
        li.nudge_accept_rate === undefined                      ? null : li.nudge_accept_rate,
      ],
    );
  } catch (err) {
    // Privacy: log a 6-char prefix only — never the full hash.
    logger.error(
      {
        identity_prefix: identity_hash.slice(0, 6),
        err: err instanceof Error ? err.message : String(err),
      },
      "daily-active: insert failed",
    );
    return c.json({ error: "Insert failed" }, 500);
  }

  return c.json({ ok: true }, 202);
});

export default router;
