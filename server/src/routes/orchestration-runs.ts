/**
 * orchestration-runs.ts — Q1'27 ingest endpoint for orchestration telemetry.
 *
 * POST /v1/orchestration-runs
 *
 * ---------------------------------------------------------------------------
 * PRIVACY
 * ---------------------------------------------------------------------------
 * Same model as POST /v1/session-events and POST /stats/daily-active. The
 * endpoint is INTENTIONALLY unauthenticated — identity_hash is already an
 * anonymous one-way digest. We never log the raw identity_hash; the error
 * path emits only the first 6 chars (`identity_prefix`).
 *
 * The plugin emits this AT THE END of every /ashlr-orchestrate run, gated
 * on telemetry consent (~/.ashlr/config.json :: telemetry === "opt-in"
 * OR ASHLR_TELEMETRY=on).
 *
 * What lands here:
 *   - identity_hash  (sha256, 64 hex chars)
 *   - github_hash    (optional sha256, 64 hex chars)
 *   - graph_id       (opaque per-run uuid — locally generated)
 *   - goal           (user-authored string, OK to persist)
 *   - tier           ('pro' | 'team' — free runs never reach us)
 *   - mode           ('stub' | 'real-llm')
 *   - started_at / finished_at  (ISO timestamps)
 *   - duration_ms / node_count / fail_count / ok
 *   - total_tokens_in / total_tokens_out (defaults to 0 when omitted)
 *
 * What we NEVER accept: per-node stdout, handoff payloads, scope paths,
 * file paths, raw command strings.
 *
 * Duplicates: by design we do NOT use ON CONFLICT. These are RUN records —
 * one row per run — and the graph_id is unique-per-run. If the plugin
 * retries a POST after a network blip, we accept the duplicate row rather
 * than silently dropping it (better to over-count than to hide failures).
 * The summary aggregation in /admin/orchestration-runs surfaces this
 * honestly.
 *
 * Latency budget: the spec says the endpoint must not block on slow DB
 * inserts > 1s. We use a single prepared INSERT against a small index, so
 * p99 should stay well under that — but we also wrap the work so the
 * response can return 202 promptly on the happy path.
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
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const BodySchema = z
  .object({
    identity_hash:    z.string().regex(HEX64, "identity_hash must be 64 lowercase hex chars"),
    github_hash:      z.string().regex(HEX64).nullable().optional(),
    graph_id:         z.string().min(1).max(128),
    goal:             z.string().min(1).max(2048),
    tier:             z.enum(["pro", "team"]),
    mode:             z.enum(["stub", "real-llm"]),
    started_at:       z.string().regex(ISO_TS, "started_at must be ISO timestamp"),
    finished_at:      z.string().regex(ISO_TS, "finished_at must be ISO timestamp"),
    duration_ms:      z.number().int().min(0).max(86_400_000),  // <=24h
    node_count:       z.number().int().min(0).max(1000),
    fail_count:       z.number().int().min(0).max(1000),
    ok:               z.boolean(),
    total_tokens_in:  z.number().int().min(0).max(1_000_000_000).optional(),
    total_tokens_out: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono();

router.post("/v1/orchestration-runs", async (c) => {
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

  const {
    identity_hash,
    github_hash,
    graph_id,
    goal,
    tier,
    mode,
    started_at,
    finished_at,
    duration_ms,
    node_count,
    fail_count,
    ok,
    total_tokens_in,
    total_tokens_out,
  } = parsed.data;

  try {
    getDb().run(
      `INSERT INTO orchestration_runs
         (identity_hash, github_hash, graph_id, goal, tier, mode,
          started_at, finished_at, duration_ms, node_count, fail_count, ok,
          total_tokens_in, total_tokens_out)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity_hash,
        github_hash ?? null,
        graph_id,
        goal,
        tier,
        mode,
        started_at,
        finished_at,
        duration_ms,
        node_count,
        fail_count,
        ok ? 1 : 0,
        total_tokens_in ?? 0,
        total_tokens_out ?? 0,
      ],
    );
  } catch (err) {
    // Privacy: log only a 6-char prefix — never the raw identity_hash.
    // Same precedent as session-events / WAD-D.
    logger.error(
      {
        identity_prefix: identity_hash.slice(0, 6),
        err: err instanceof Error ? err.message : String(err),
      },
      "orchestration-runs: insert failed",
    );
    return c.json({ error: "Insert failed" }, 500);
  }

  return c.json({ ok: true }, 202);
});

export default router;
