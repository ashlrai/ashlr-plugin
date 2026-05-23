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

const BodySchema = z.object({
  identity_hash:  z.string().regex(HEX64, "identity_hash must be 64 lowercase hex chars"),
  github_hash:    z.string().regex(HEX64).nullable().optional(),
  date:           z.string().regex(ISO_DATE, "date must be YYYY-MM-DD"),
  plugin_version: z.string().min(1).max(64),
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

  const { identity_hash, github_hash, date, plugin_version } = parsed.data;

  // Idempotent insert — duplicates for same (identity_hash, active_date) are
  // dropped silently. This is the upsert behavior the client relies on for
  // the daily heartbeat retry path.
  try {
    getDb().run(
      `INSERT INTO daily_active_records
         (identity_hash, github_hash, active_date, plugin_version)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (identity_hash, active_date) DO NOTHING`,
      [identity_hash, github_hash ?? null, date, plugin_version],
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
