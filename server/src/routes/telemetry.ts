/**
 * telemetry.ts — Opt-in anonymized telemetry ingest.
 *
 * POST /v1/events
 *
 * Accepts a batch of pre-anonymized events from `scripts/telemetry-flush.ts`
 * (the v1.23 client). The client guarantees no paths/patterns/content; this
 * route adds defense-in-depth by re-running the same `looksLikePath()` check
 * server-side and dropping any event whose payload values look path-shaped.
 *
 * Privacy contract (mirrored from docs/telemetry.md):
 *   - sessionId is an opaque 16-char hex per-session value (not a user id).
 *     Re-installs and new sessions get fresh values.
 *   - Stored as session_id_hash (SHA-256 fold) so even leaked dumps can't
 *     be reverse-correlated to the original 16 bytes the client knows.
 *   - Payload is stored as JSON for query flexibility, but every string
 *     field is path-checked first.
 *
 * Rate limit: 10 requests / minute / session-id (each request can carry up
 * to 500 events). Sub-second bursts allowed inside the window. The per-event
 * cap is enforced by the BodySchema's `events.max(500)`.
 *
 * Body shape: { sessionId: string, events: Array<{ ts, kind, sessionId, ...payload }> }
 * Response:   { accepted: number }
 */

import { Hono } from "hono";
import { z } from "zod";
import { createHash } from "crypto";
import { checkRateLimitBucket } from "../lib/ratelimit.js";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";
import { cTelemetryEventsAccepted, cTelemetryEventsDropped } from "../lib/metrics.js";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const KIND_VALUES = [
  "tool_call",
  "pretooluse_block",
  "pretooluse_passthrough",
  "version",
  "multi_turn_stale_estimate",
] as const;

/**
 * Per-event schema. We accept ANY shape with the required fields and validate
 * the rest manually so future event kinds don't break the ingest endpoint —
 * forwards-compat is more important than strict per-kind validation here.
 */
const EventSchema = z.object({
  ts:        z.number().int().nonnegative(),
  kind:      z.enum(KIND_VALUES),
  sessionId: z.string().min(1).max(64),
}).passthrough();

const BodySchema = z.object({
  sessionId: z.string().min(1).max(64),
  events:    z.array(EventSchema).min(0).max(500),
});

// ---------------------------------------------------------------------------
// Path-shaped value detector (mirror of servers/_telemetry.ts looksLikePath)
// ---------------------------------------------------------------------------

/**
 * Returns true if `s` looks like an absolute filesystem path. Mirrors the
 * client-side guard in servers/_telemetry.ts line 310.
 */
export function looksLikePath(s: string): boolean {
  if (s.length < 3) return false;
  // POSIX absolute: starts with /
  if (s.startsWith("/")) return true;
  // Windows absolute: C:\ or C:/
  if (/^[A-Za-z]:[/\\]/.test(s)) return true;
  // Windows UNC: \\server\share
  if (s.startsWith("\\\\")) return true;
  return false;
}

/** Walk an event's payload and return true if any string value is path-shaped. */
function eventCarriesPath(event: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(event)) {
    // sessionId is a hex hash — never a path even at 16 chars; skip
    if (k === "sessionId") continue;
    if (typeof v === "string" && looksLikePath(v)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Session-id hashing
// ---------------------------------------------------------------------------

/**
 * SHA-256-fold the client-supplied sessionId so even raw row dumps can't
 * be reverse-correlated to the original 16-byte hex the client knows.
 * Returns the first 32 chars of the hex digest.
 */
function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf-8").digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const telemetry = new Hono();

telemetry.post("/v1/events", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); }
  catch {
    cTelemetryEventsDropped.inc({ reason: "malformed-json" });
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    cTelemetryEventsDropped.inc({ reason: "schema-invalid" });
    return c.json({ error: "Schema validation failed", issues: parsed.error.issues }, 400);
  }

  const { sessionId, events } = parsed.data;
  const sessionHash = hashSessionId(sessionId);

  // Sliding-window rate limit: 10 POSTs / minute / session-hash. Each POST
  // can carry up to 500 events (BodySchema cap). Realistic clients flush
  // every hour or on session-end — well under this ceiling.
  if (!checkRateLimitBucket(`tel:${sessionHash}`, 60_000, 10)) {
    cTelemetryEventsDropped.inc({ reason: "rate-limited" });
    return c.json({ error: "Rate limit: max 10 requests per minute per session" }, 429);
  }

  if (events.length === 0) {
    return c.json({ accepted: 0 });
  }

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO telemetry_events (session_id_hash, ts, kind, payload)
    VALUES (?, ?, ?, ?)
  `);

  let accepted = 0;
  let droppedPaths = 0;
  let droppedSessionMismatch = 0;

  // One transaction per batch — atomic + fast.
  const insertAll = db.transaction((rows: Array<{ ts: number; kind: string; payload: string }>) => {
    for (const r of rows) insert.run(sessionHash, r.ts, r.kind, r.payload);
  });

  const rowsToInsert: Array<{ ts: number; kind: string; payload: string }> = [];

  for (const evt of events) {
    // Defense-in-depth: drop if the per-event sessionId disagrees with the
    // batch sessionId. (Client should never do this, but we don't trust it.)
    if (evt.sessionId !== sessionId) {
      droppedSessionMismatch++;
      continue;
    }

    // Defense-in-depth: re-run looksLikePath() server-side. Client already
    // dropped these, but if a bug let one slip through, we drop here too.
    if (eventCarriesPath(evt as Record<string, unknown>)) {
      droppedPaths++;
      continue;
    }

    // Strip sessionId from the stored payload (it's already in the hashed
    // session_id_hash column; storing it again would duplicate the link).
    const { sessionId: _ignored, ts, kind, ...payload } = evt as Record<string, unknown>;
    rowsToInsert.push({
      ts: ts as number,
      kind: kind as string,
      payload: JSON.stringify(payload),
    });
  }

  if (rowsToInsert.length > 0) {
    try {
      insertAll(rowsToInsert);
      accepted = rowsToInsert.length;
      for (const r of rowsToInsert) {
        cTelemetryEventsAccepted.inc({ kind: r.kind });
      }
    } catch (err) {
      logger.error({ err, sessionHash }, "telemetry: insert failed");
      cTelemetryEventsDropped.inc({ reason: "db-error" });
      return c.json({ error: "Storage error" }, 500);
    }
  }

  if (droppedPaths > 0) {
    cTelemetryEventsDropped.inc({ reason: "path-shaped" }, droppedPaths);
    logger.warn({ sessionHash, droppedPaths }, "telemetry: dropped path-shaped events server-side");
  }
  if (droppedSessionMismatch > 0) {
    cTelemetryEventsDropped.inc({ reason: "session-mismatch" }, droppedSessionMismatch);
  }

  return c.json({ accepted });
});

export default telemetry;
