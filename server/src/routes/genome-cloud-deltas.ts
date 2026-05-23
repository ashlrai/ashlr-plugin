/**
 * genome-cloud-deltas.ts — Q2 cloud delta sync read endpoint.
 *
 * GET /genome/cloud-deltas?genome_id=X&since_cursor=N&limit=100
 *   → { deltas: [{ id, kind, sourceSha, recordedAt, cursor, payload }],
 *       nextCursor: N }
 *
 * Auth: Bearer token middleware (authMiddleware). Pro/Team only.
 * Authorization: the caller must own the genome (personal) or be a member
 * of the team that owns it. Free tier is rejected via requireTier before
 * any genome lookup so we don't leak existence to free users.
 *
 * Wire format example (one delta):
 *   {
 *     "id": 17,
 *     "cursor": 17,
 *     "kind": "commit",
 *     "sourceSha": "abc123…",
 *     "recordedAt": "2026-05-22T12:34:56Z",
 *     "payload": { "kind": "commit", "sha": "abc…", "message": "…", … }
 *   }
 */

import { Hono } from "hono";
import { authMiddleware, requireTier } from "../lib/auth.js";
import { getGenomeById, getTeamForUser } from "../db.js";
import { listGenomeDeltas } from "../lib/genome-deltas.js";

const router = new Hono();
router.use("/genome/cloud-deltas", authMiddleware);

router.get("/genome/cloud-deltas", (c) => {
  const user = c.get("user");

  // Tier gate FIRST — free callers get 403 before any DB lookup so we
  // don't reveal whether a genome_id exists.
  const deny = requireTier(c, user, "pro");
  if (deny) return deny;

  const genomeId = c.req.query("genome_id");
  if (!genomeId || typeof genomeId !== "string") {
    return c.json({ error: "genome_id required" }, 400);
  }

  // Parse cursor + limit. Defaults: cursor=0, limit=100 (cap 500).
  const sinceCursorRaw = c.req.query("since_cursor") ?? "0";
  const limitRaw = c.req.query("limit") ?? "100";
  const sinceCursor = Number.parseInt(sinceCursorRaw, 10);
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(sinceCursor) || sinceCursor < 0) {
    return c.json({ error: "since_cursor must be a non-negative integer" }, 400);
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return c.json({ error: "limit must be a positive integer" }, 400);
  }
  const cappedLimit = Math.min(500, limit);

  // Authorization: the user must own this genome (personal) or belong to
  // the team that owns it. 404 (not 403) when the genome doesn't exist OR
  // isn't accessible — never leak existence.
  const genome = getGenomeById(genomeId);
  if (!genome) return c.json({ error: "not found" }, 404);

  // Personal genome: owner_user_id matches the caller.
  // Team genome: caller is a member of the team referenced by org_id.
  let authorized = false;
  if (genome.owner_user_id && genome.owner_user_id === user.id) {
    authorized = true;
  } else if (genome.org_id) {
    const team = getTeamForUser(user.id);
    if (team && team.team.id === genome.org_id) authorized = true;
  }
  if (!authorized) return c.json({ error: "not found" }, 404);

  const { rows, nextCursor } = listGenomeDeltas({
    genomeId,
    sinceCursor,
    limit: cappedLimit,
  });

  const deltas = rows.map((r) => {
    let payload: unknown;
    try {
      payload = JSON.parse(r.delta_payload_json);
    } catch {
      payload = null;
    }
    return {
      id: r.id,
      cursor: r.consumed_cursor,
      kind: r.delta_kind,
      sourceSha: r.source_sha,
      recordedAt: r.recorded_at,
      payload,
    };
  });

  return c.json({ deltas, nextCursor });
});

export default router;
