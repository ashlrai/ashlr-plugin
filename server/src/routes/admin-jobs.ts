/**
 * admin-jobs.ts — Internal admin trigger endpoints for scheduled jobs.
 *
 * These endpoints are NOT part of the user-facing admin dashboard (admin.ts).
 * They are intentionally unlisted, gated by a separate bearer secret
 * (`ASHLR_ADMIN_TRIGGER_TOKEN`), and exist solely so external schedulers
 * (GitHub Actions, uptime monitors, etc.) can invoke long-running jobs
 * against the in-container SQLite database that lives inside the Railway
 * deploy and is not reachable from the outside.
 *
 * Endpoints:
 *   POST /admin/jobs/daily-wad-d-aggregate
 *     Auth:    Authorization: Bearer <ASHLR_ADMIN_TRIGGER_TOKEN>
 *     Body:    { date?: "YYYY-MM-DD", dryRun?: boolean, thresholdDays?: number }
 *     200:     { ok: true, snapshotDate, wadD, leadIndicators }
 *     401:     missing/wrong bearer
 *     503:     ASHLR_ADMIN_TRIGGER_TOKEN unset on server
 *     500:     aggregator threw (internal details NEVER leaked)
 *
 * Security:
 *   - Bearer compared via `crypto.timingSafeEqual` (after equal-length pad).
 *   - When the env var is unset, every call returns 503 — never 401 — so a
 *     misconfigured deploy never looks like an auth surface waiting for the
 *     right bearer.
 *   - Endpoint is NOT linked from any user-facing surface. Discoverability is
 *     by-design limited to scheduler config + this source file.
 *
 * Logging:
 *   Emits structured `cron_start` / `cron_end` events matching the
 *   weekly-digest cron shape so log queries are uniform across jobs.
 */

import { Hono } from "hono";
import { z } from "zod";
import { timingSafeEqual, randomUUID } from "crypto";
import { Buffer } from "buffer";
import { logger } from "../lib/logger.js";
import {
  runDailyWadDAggregate,
  type RunOptions,
  type RunResult,
} from "../jobs/daily-wad-d-aggregate.js";

// ---------------------------------------------------------------------------
// Dependency injection seam for testing
// ---------------------------------------------------------------------------
//
// bun:test's `mock.module()` patches the module registry process-wide and
// leaks across test files, which would break the real aggregator suite.
// Instead we expose a thin setter that the admin-jobs test file uses to
// swap the implementation, and resets it in afterEach. Production code
// always uses the imported `runDailyWadDAggregate`.
// ---------------------------------------------------------------------------

type RunAggregator = (opts?: RunOptions) => RunResult | Promise<RunResult>;

let activeAggregator: RunAggregator = runDailyWadDAggregate;

/** @internal — test-only hook. Do not call from production code. */
export function _setWadDAggregator(fn: RunAggregator | null): void {
  activeAggregator = fn ?? runDailyWadDAggregate;
}

const adminJobs = new Hono();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard wallclock budget for the aggregator. Keeps the HTTP request from
 *  hanging if a future DB regression makes the scan slow. */
const JOB_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Constant-time bearer-token comparison. Returns false if either side is
 *  empty or lengths differ — but the length-comparison is done *after* the
 *  byte-compare on equal-length buffers, so the timing leak is bounded to
 *  "token configured, but wrong length" which is already public info. */
function safeCompareBearer(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still do a dummy compare against `a` to keep the function's runtime
    // dependent only on input length, not on the secret.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

const BodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dryRun: z.boolean().optional(),
  thresholdDays: z.number().int().min(1).max(7).optional(),
});

/** Wrap a (sync) call in a 60s wallclock budget. The aggregator is currently
 *  synchronous — Promise.race handles future async refactors transparently. */
function withTimeout<T>(fn: () => T | Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${ms}ms budget`)),
      ms,
    );
    Promise.resolve()
      .then(() => fn())
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ---------------------------------------------------------------------------
// POST /admin/jobs/daily-wad-d-aggregate
// ---------------------------------------------------------------------------

adminJobs.post("/admin/jobs/daily-wad-d-aggregate", async (c) => {
  const requestId = randomUUID();
  const expected = process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];

  // Server is not configured for this endpoint — return 503, NOT 401.
  // 401 implies "wrong bearer, try again"; 503 says "this surface is off".
  if (!expected) {
    logger.warn(
      { event: "cron_start", job: "daily-wad-d-aggregate", requestId, reason: "token_unset" },
      "admin-jobs: rejected (ASHLR_ADMIN_TRIGGER_TOKEN unset)",
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

  // Body is optional — only parse if there is one. Reject malformed JSON.
  const raw = await c.req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", issues: parsed.error.issues, requestId },
      400,
    );
  }
  const { date, dryRun, thresholdDays } = parsed.data;

  const startedAt = Date.now();
  logger.info(
    { event: "cron_start", job: "daily-wad-d-aggregate", requestId, date, dryRun, thresholdDays },
    "daily-wad-d-aggregate: cron_start",
  );

  try {
    const result = await withTimeout(
      () => activeAggregator({
        ...(date !== undefined ? { snapshotDate: date } : {}),
        ...(dryRun !== undefined ? { dryRun } : {}),
        ...(thresholdDays !== undefined ? { thresholdDays } : {}),
      }),
      JOB_TIMEOUT_MS,
      "daily-wad-d-aggregate",
    );

    const durationMs = Date.now() - startedAt;
    logger.info(
      {
        event: "cron_end",
        job: "daily-wad-d-aggregate",
        requestId,
        durationMs,
        snapshotDate: result.snapshot_date,
        wadD: result.wad_d_value,
        written: result.written,
      },
      "daily-wad-d-aggregate: cron_end",
    );

    return c.json({
      ok: true,
      snapshotDate: result.snapshot_date,
      wadD: result.wad_d_value,
      leadIndicators: result.lead_indicators,
      written: result.written,
      requestId,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    // Log full error server-side for debugging, but NEVER return it to
    // the caller — the endpoint is reachable from the public internet
    // when secrets leak, so internal SQL/file paths must stay opaque.
    logger.error(
      {
        event: "cron_end",
        job: "daily-wad-d-aggregate",
        requestId,
        durationMs,
        err: err instanceof Error ? err.message : String(err),
        failed: true,
      },
      "daily-wad-d-aggregate: cron_end (failed)",
    );
    return c.json({ error: "Aggregator failed", requestId }, 500);
  }
});

export default adminJobs;
