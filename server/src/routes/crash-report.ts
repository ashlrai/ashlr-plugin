/**
 * crash-report.ts — Anonymous crash-dump ingest.
 *
 * POST /crash-report
 *
 * Accepts a pre-redacted crash record from the plugin (opt-in, user-initiated
 * via `/ashlr-report-crash`) and logs it so the maintainer can triage.
 *
 * No auth required — reports are anonymous unless the client attaches a
 * Pro bearer token, in which case `hasProToken: true` is tagged on the
 * log line for triage priority.
 *
 * Storage: structured log via pino + Prometheus counter. Persistent
 * database storage is deferred until volume justifies a `crash_reports`
 * table; the pino sink + log aggregation already covers maintainer
 * visibility at current scale.
 */

import { Hono } from "hono";
import { randomUUID } from "crypto";
import { z } from "zod";
import { checkRateLimit } from "../lib/ratelimit.js";
import { logger } from "../lib/logger.js";
import { cCrashReports } from "../lib/metrics.js";

const RecordSchema = z.object({
  ts:      z.string().min(1).max(64),
  tool:    z.string().min(1).max(128),
  message: z.string().max(4096),
  stack:   z.string().max(8192).optional(),
  args:    z.string().max(4096),
  node:    z.string().max(64).optional(),
  bun:     z.string().max(64).optional(),
});

const BodySchema = z.object({
  record:        RecordSchema,
  pluginVersion: z.string().max(64).optional(),
  platform:      z.string().max(32).optional(),
});

const crashReport = new Hono();

crashReport.post("/crash-report", async (c) => {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown";

  // 1 req/min per IP keeps a single misbehaving client from flooding the
  // maintainer's log pipeline. Crashes are rare; this cap is generous.
  if (!checkRateLimit(`crash:${ip}`, 60_000)) {
    return c.json({ error: "Rate limit: max 1 crash report per minute per IP" }, 429);
  }

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Invalid JSON" }, 400); }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", issues: parsed.error.issues }, 400);
  }

  const reportId = randomUUID();
  const receivedAt = new Date().toISOString();

  const authHeader = c.req.header("authorization");
  const hasProToken = !!(authHeader && authHeader.startsWith("Bearer "));
  const platform = parsed.data.platform ?? "unknown";

  logger.info(
    {
      event:         "crash_report",
      reportId,
      receivedAt,
      pluginVersion: parsed.data.pluginVersion ?? "unknown",
      platform,
      hasProToken,
      record:        parsed.data.record,
    },
    "crash report received",
  );
  cCrashReports.inc({ platform });

  return c.json({ reportId, receivedAt });
});

export default crashReport;
