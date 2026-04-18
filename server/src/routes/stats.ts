/**
 * stats.ts — Stats sync service.
 *
 * POST /stats/sync  — accept a stats payload from a plugin client, store it.
 * GET  /stats/aggregate — return the caller's aggregated view (all machines).
 *
 * Privacy invariant: the schema only accepts pure counts. Any field that looks
 * like a file path, cwd, or content string is rejected at the zod layer.
 */

import { Hono } from "hono";
import { z } from "zod";
import { getUserByToken, upsertStatsUpload, aggregateUploads } from "../db.js";
import { authMiddleware } from "../lib/auth.js";
import { checkRateLimit } from "../lib/ratelimit.js";

// ---------------------------------------------------------------------------
// Privacy guard: reject strings that look like filesystem paths or content
// ---------------------------------------------------------------------------

function looksLikePath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  // Matches absolute Unix/Mac/Windows paths or anything with a path separator
  return /^\/|^[A-Za-z]:\\|[/\\]{2}/.test(value) || value.includes("/../");
}

function hasSuspiciousField(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    // Reject known sensitive field names
    const lower = key.toLowerCase();
    if (["cwd", "path", "content", "file", "dir", "directory"].includes(lower)) return true;
    if (looksLikePath(val)) return true;
    if (typeof val === "object" && hasSuspiciousField(val)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Zod schema — pure counts only, no strings except the api token
// ---------------------------------------------------------------------------

// Tool breakdown: { toolName: callCount }
const ByToolSchema = z.record(z.string().max(64), z.number().int().nonnegative());

// Day breakdown: { "YYYY-MM-DD": tokensSaved }
const ByDaySchema = z.record(
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  z.number().int().nonnegative(),
);

const LifetimeSchema = z.object({
  calls:       z.number().int().nonnegative(),
  tokensSaved: z.number().int().nonnegative(),
  byTool:      ByToolSchema.optional().default({}),
  byDay:       ByDaySchema.optional().default({}),
});

const SyncBodySchema = z.object({
  apiToken: z.string().min(16).max(256),
  stats: z.object({
    lifetime:      LifetimeSchema,
    // sessions and summarization are accepted but not stored in Phase 1
    sessions:      z.record(z.string(), z.unknown()).optional(),
    summarization: z.record(z.string(), z.unknown()).optional(),
  }),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const stats = new Hono();

// POST /stats/sync — no auth middleware; token is in the body
stats.post("/stats/sync", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Privacy check before schema validation
  if (hasSuspiciousField(body)) {
    return c.json({ error: "Payload contains disallowed fields (path or content data)" }, 422);
  }

  const parsed = SyncBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", issues: parsed.error.issues }, 400);
  }

  const { apiToken, stats: statsData } = parsed.data;

  // Rate limit: 1 req per 10s per token
  if (!checkRateLimit(apiToken)) {
    return c.json({ error: "Rate limit exceeded — max 1 request per 10 seconds" }, 429);
  }

  const user = getUserByToken(apiToken);
  if (!user) {
    return c.json({ error: "Invalid API token" }, 401);
  }

  const { lifetime } = statsData;
  upsertStatsUpload(
    user.id,
    lifetime.calls,
    lifetime.tokensSaved,
    JSON.stringify(lifetime.byTool ?? {}),
    JSON.stringify(lifetime.byDay  ?? {}),
  );

  return c.json({ ok: true });
});

// GET /stats/aggregate — requires Authorization: Bearer <token>
stats.get("/stats/aggregate", authMiddleware, (c) => {
  const user = c.get("user");
  const agg  = aggregateUploads(user.id);
  return c.json({
    user_id:               user.id,
    lifetime_calls:        agg.lifetime_calls,
    lifetime_tokens_saved: agg.lifetime_tokens_saved,
    by_tool:               agg.by_tool,
    by_day:                agg.by_day,
  });
});

export default stats;
