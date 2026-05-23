/**
 * session-events.ts — Q4 session graph capture ingest endpoint.
 *
 * POST /v1/session-events
 *
 * ---------------------------------------------------------------------------
 * PRIVACY
 * ---------------------------------------------------------------------------
 * This endpoint is INTENTIONALLY unauthenticated. The body carries:
 *   - identity_hash: 64-char lowercase hex sha256 (same shape as WAD-D).
 *     One-way; never reversible to a user, machine, email, or path.
 *   - github_hash:   OPTIONAL second sha256 (same shape) derived client-side
 *     from the user's GitHub login. Lets the deferred session graph UI
 *     collapse one developer using multiple machines into one node.
 *   - session_id_hash: sha256 of the local CLAUDE_SESSION_ID (or ppid-derived
 *     fallback). The server NEVER sees the raw session id. Idempotency key:
 *     (identity_hash, session_id_hash) — re-POSTs from the same session are
 *     dropped at the DB level.
 *   - tool_count / tokens_saved: integers summarizing the session shape.
 *   - branch_sha: OPTIONAL first 12 chars of `git rev-parse HEAD`. Not
 *     reversible to a repo on its own; combined with identity_hash it tells
 *     us "this developer's branch was X." Analogous to WAD-D's identity_hash
 *     — only ever sent when telemetry consent is on.
 *   - discovery_refs: OPTIONAL array of opaque section IDs (e.g. discovery
 *     slugs) the session touched. Local-only identifiers inside the
 *     plugin's genome — NEVER paths, NEVER content.
 *   - plugin_version: harmless string, used only for cohort reporting.
 *
 * NEVER logged: raw identity_hash, raw session_id_hash, raw discovery_refs.
 * On the error path we emit only a 6-char prefix of identity_hash so two
 * records from the same developer can be cross-referenced inside one debug
 * session without exposing the hash in shipped log dumps. Mirrors the WAD-D
 * (PR #67) and other-route (PR #73) precedent.
 * ---------------------------------------------------------------------------
 *
 * Why this is the MVP scope:
 *   - The full session graph UI (visualizing how knowledge flows across
 *     sessions) is deferred. This route only ingests the CAPTURE side.
 *   - No transcript content. Just shape metadata. Privacy is the whole point.
 *   - A future aggregator job will JOIN session_events across identity_hash
 *     + discovery_refs to derive the cross-session graph.
 */

import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
// Allow trailing 'Z' or numeric offset; we use full ISO timestamps server-side.
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
// Match the plugin emit: first 12 hex chars of git HEAD. Allow uppercase to
// tolerate non-standard configs that capitalize.
const GIT_SHA12 = /^[0-9a-fA-F]{7,40}$/;

const BodySchema = z
  .object({
    identity_hash:    z.string().regex(HEX64, "identity_hash must be 64 lowercase hex chars"),
    github_hash:      z.string().regex(HEX64).nullable().optional(),
    session_id_hash:  z.string().regex(HEX64, "session_id_hash must be 64 lowercase hex chars"),
    ended_at:         z.string().regex(ISO_TS, "ended_at must be ISO timestamp"),
    tool_count:       z.number().int().min(0).max(1_000_000),
    tokens_saved:     z.number().int().min(0).max(1_000_000_000),
    branch_sha:       z.string().regex(GIT_SHA12).nullable().optional(),
    // Cap at 200 refs/session — generous; defends against pathological inputs.
    // Each ref capped at 128 chars (section ID slug shape).
    discovery_refs:   z.array(z.string().min(1).max(128)).max(200).optional(),
    plugin_version:   z.string().min(1).max(64),
  })
  .strict();

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono();

router.post("/v1/session-events", async (c) => {
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
    session_id_hash,
    ended_at,
    tool_count,
    tokens_saved,
    branch_sha,
    discovery_refs,
    plugin_version,
  } = parsed.data;

  // Serialize discovery refs as JSON. We *never* mutate the values — they're
  // already opaque IDs from the client's local genome. Empty array when
  // missing, which the schema documents as the default.
  const refsJson = JSON.stringify(discovery_refs ?? []);

  try {
    // ON CONFLICT DO NOTHING — idempotent re-emit per (identity, session).
    // Safe to call from the SessionEnd hook even if the plugin retries.
    getDb().run(
      `INSERT INTO session_events
         (identity_hash, github_hash, session_id_hash, ended_at,
          tool_count, tokens_saved, branch_sha, discovery_refs_json,
          plugin_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (identity_hash, session_id_hash) DO NOTHING`,
      [
        identity_hash,
        github_hash ?? null,
        session_id_hash,
        ended_at,
        tool_count,
        tokens_saved,
        branch_sha ?? null,
        refsJson,
        plugin_version,
      ],
    );
  } catch (err) {
    // Privacy: log a 6-char prefix only — never the full hash. Matches
    // the WAD-D + crash-report (PR #73) precedent.
    logger.error(
      {
        identity_prefix: identity_hash.slice(0, 6),
        err: err instanceof Error ? err.message : String(err),
      },
      "session-events: insert failed",
    );
    return c.json({ error: "Insert failed" }, 500);
  }

  return c.json({ ok: true }, 202);
});

export default router;
