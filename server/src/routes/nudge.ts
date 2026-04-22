/**
 * nudge.ts — Nudge telemetry ingest.
 *
 * POST /events/nudge — accept a batch of nudge-shown / clicked / dismissed
 * events from a plugin client and store them under the authenticated user.
 *
 * Privacy: accepts exactly the fields the client emits — no cwd, no paths,
 * no content. sessionId arrives pre-hashed by the client. tokenCount is a
 * bucketed integer.
 */

import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../lib/auth.js";
import { checkRateLimit } from "../lib/ratelimit.js";
import { insertNudgeEvents } from "../db.js";

const EventSchema = z.object({
  ts:          z.string().min(1).max(64),
  event:       z.enum(["nudge_shown", "nudge_clicked", "nudge_dismissed_implicitly"]),
  sessionId:   z.string().min(1).max(128),
  tokenCount:  z.number().int().nonnegative().max(10_000_000),
  variant:     z.string().min(1).max(32),
  nudgeId:     z.string().min(1).max(64),
});

const BodySchema = z.object({
  events: z.array(EventSchema).min(0).max(500),
});

const nudge = new Hono();

nudge.post("/events/nudge", authMiddleware, async (c) => {
  const user = c.get("user");

  if (!checkRateLimit(`nudge:${user.id}`)) {
    return c.json({ error: "Rate limit exceeded — max 1 request per 10 seconds" }, 429);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", issues: parsed.error.issues }, 400);
  }

  const rows = parsed.data.events.map((e) => ({
    userId:     user.id,
    ts:         e.ts,
    event:      e.event,
    sessionId:  e.sessionId,
    tokenCount: e.tokenCount,
    variant:    e.variant,
    nudgeId:    e.nudgeId,
  }));

  const stored = insertNudgeEvents(rows);
  return c.json({ stored });
});

export default nudge;
