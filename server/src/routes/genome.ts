/**
 * genome.ts — Team CRDT genome sync endpoints (Phase 3).
 *
 * All routes require Bearer auth + "team" tier.
 *
 * CRDT strategy: LWW-Element-Set at section granularity.
 *   - Each section carries a vector clock: { [clientId]: count }
 *   - Merge rule: component-wise max of vclocks
 *   - Conflict: incoming vclock neither dominates nor is dominated by stored vclock
 *     (concurrent edits) → store both as a conflict pair
 *   - Resolution: caller picks a winner via POST /resolve
 *
 * Security notes:
 *   - Section paths are sanitized: no "..", no absolute paths, no "//"
 *   - Content capped at 1 MB per section
 *   - Push rate limited: 10 sections/minute/client
 *   - Encryption deferred to v2; teams opt in knowing content is stored in plaintext
 */

import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, requireTier } from "../lib/auth.js";
import {
  upsertGenome,
  getGenomeById,
  requireGenomeAccess,
  deleteGenome,
  bumpGenomeSeq,
  upsertGenomeSection,
  getGenomeSectionsSince,
  getGenomeSectionByPath,
  getGenomeConflicts,
  upsertGenomeConflict,
  resolveGenomeConflict,
  setEncryptionRequired,
  logGenomePush,
  countRecentGenomePushes,
  getTeamForUser,
  type GenomeSection,
} from "../db.js";

// ---------------------------------------------------------------------------
// Encryption detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the content string looks like an AES-256-GCM ciphertext blob.
 * Format: base64url of [ version(1) | nonce(12) | authTag(16) | ciphertext(var) ]
 * Minimum encoded length for empty plaintext: ceil((1+12+16)*8/6) = 39 chars.
 */
function looksEncrypted(content: string): boolean {
  return /^[A-Za-z0-9_-]{39,}$/.test(content);
}

const genome = new Hono();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SECTION_BYTES = 1_048_576; // 1 MB
const PUSH_RATE_WINDOW_MS = 60_000;  // 1 minute
const PUSH_RATE_MAX = 10;            // sections per minute per client

// ---------------------------------------------------------------------------
// Path sanitization
// ---------------------------------------------------------------------------

/** Returns true when a section path is safe to store. */
function isValidSectionPath(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  if (p.startsWith("/")) return false;           // no absolute paths
  if (p.includes("..")) return false;            // no directory traversal
  if (p.includes("//")) return false;            // no double-slash
  if (p.length > 512) return false;              // sanity cap
  return true;
}

// ---------------------------------------------------------------------------
// Vclock helpers — no CRDT library, trivially correct
// ---------------------------------------------------------------------------

type VClock = Record<string, number>;

/** Merge two vclocks: component-wise maximum. */
function mergeVClocks(a: VClock, b: VClock): VClock {
  const result: VClock = { ...a };
  for (const [k, v] of Object.entries(b)) {
    result[k] = Math.max(result[k] ?? 0, v);
  }
  return result;
}

/**
 * Compare two vclocks.
 * Returns:
 *   "dominated"  — incoming is strictly older than stored (stored dominates)
 *   "dominates"  — incoming is strictly newer than or equal to stored
 *   "concurrent" — neither dominates the other (conflict)
 */
function compareVClocks(incoming: VClock, stored: VClock): "dominated" | "dominates" | "concurrent" {
  let incomingAhead = false;
  let storedAhead = false;

  const allKeys = new Set([...Object.keys(incoming), ...Object.keys(stored)]);
  for (const k of allKeys) {
    const iv = incoming[k] ?? 0;
    const sv = stored[k] ?? 0;
    if (iv > sv) incomingAhead = true;
    if (sv > iv) storedAhead = true;
  }

  if (incomingAhead && !storedAhead) return "dominates";
  if (!incomingAhead && storedAhead) return "dominated";
  if (!incomingAhead && !storedAhead) return "dominates"; // equal — treat as safe update
  return "concurrent";
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const InitSchema = z.object({
  orgId:   z.string().min(1).max(256),
  repoUrl: z.string().min(1).max(1024),
});

const SectionInputSchema = z.object({
  path:    z.string(),
  content: z.string().max(MAX_SECTION_BYTES, "Section content exceeds 1 MB"),
  vclock:  z.record(z.string(), z.number().int().nonnegative()),
});

const PushSchema = z.object({
  sections: z.array(SectionInputSchema).min(1).max(100),
  manifest: z.record(z.string(), z.unknown()).optional(),
  clientId: z.string().min(1).max(256),
});

const ResolveSchema = z.object({
  path:    z.string(),
  winning: z.object({
    content: z.string().max(MAX_SECTION_BYTES),
    vclock:  z.record(z.string(), z.number().int().nonnegative()),
  }),
});

// ---------------------------------------------------------------------------
// Middleware: all genome routes need auth + team tier
// ---------------------------------------------------------------------------

genome.use("/genome/*", authMiddleware);

// ---------------------------------------------------------------------------
// POST /genome/init
// ---------------------------------------------------------------------------

genome.post("/genome/init", async (c) => {
  const user = c.get("user");
  const deny = requireTier(c, user, "team");
  if (deny) return deny;

  const membership = getTeamForUser(user.id);
  if (!membership) return c.json({ error: "No team membership found" }, 403);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const parsed = InitSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);

  const { repoUrl } = parsed.data;
  // org_id is always the caller's team ID — never trust the client-supplied orgId
  // for ownership. Using team.id makes all downstream access checks consistent.
  const { genome: g } = upsertGenome(membership.team.id, repoUrl);

  // cloneToken is a stable derivative of the genomeId — not a secret, just a
  // recognizable handle clients can store to identify the sync target.
  const cloneToken = `gclone_${g.id.replace(/-/g, "")}`;

  return c.json({ genomeId: g.id, cloneToken });
});

// ---------------------------------------------------------------------------
// POST /genome/:genomeId/push
// ---------------------------------------------------------------------------

genome.post("/genome/:genomeId/push", async (c) => {
  const user = c.get("user");
  const deny = requireTier(c, user, "team");
  if (deny) return deny;

  const membership = getTeamForUser(user.id);
  const genomeId = c.req.param("genomeId");
  const g = membership ? requireGenomeAccess(genomeId, membership.team.id) : null;
  if (!g) return c.json({ error: "Genome not found" }, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const parsed = PushSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);

  const { sections, clientId } = parsed.data;

  // Rate limit: 10 sections/minute/client
  const recentCount = countRecentGenomePushes(genomeId, clientId, PUSH_RATE_WINDOW_MS);
  if (recentCount + sections.length > PUSH_RATE_MAX) {
    return c.json({ error: "Push rate limit exceeded (10 sections/minute)" }, 429);
  }

  // Encryption enforcement: if the genome requires encryption, reject plaintext pushes
  if (g.encryption_required === 1) {
    for (const sec of sections) {
      if (!looksEncrypted(sec.content)) {
        return c.json(
          { error: `Encryption required: section '${sec.path}' must be encrypted before push` },
          422,
        );
      }
    }
  }

  const applied: string[] = [];
  const conflicts: string[] = [];

  for (const sec of sections) {
    if (!isValidSectionPath(sec.path)) {
      return c.json({ error: `Invalid section path: ${sec.path}` }, 400);
    }

    const existing = getGenomeSectionByPath(genomeId, sec.path);
    const incomingVclock = sec.vclock as VClock;
    const isEncrypted = looksEncrypted(sec.content);

    let finalContent = sec.content;
    let finalVclock  = incomingVclock;
    let isConflict   = false;

    if (existing) {
      let storedVclock: VClock;
      try { storedVclock = JSON.parse(existing.vclock_json) as VClock; } catch { storedVclock = {}; }

      const relation = compareVClocks(incomingVclock, storedVclock);

      if (relation === "dominated") {
        // Incoming is stale — treat as conflict so neither is lost
        isConflict   = true;
        finalContent = existing.content; // keep stored as canonical
        finalVclock  = mergeVClocks(incomingVclock, storedVclock);

        const variants = [
          { content: existing.content, vclock: storedVclock, authorHint: "stored" },
          { content: sec.content,      vclock: incomingVclock, authorHint: clientId },
        ];
        upsertGenomeConflict(genomeId, sec.path, JSON.stringify(variants));
        conflicts.push(sec.path);
      } else if (relation === "concurrent") {
        isConflict   = true;
        finalVclock  = mergeVClocks(incomingVclock, storedVclock);
        finalContent = sec.content; // last writer wins for display; conflict recorded

        const variants = [
          { content: existing.content, vclock: storedVclock, authorHint: "stored" },
          { content: sec.content,      vclock: incomingVclock, authorHint: clientId },
        ];
        upsertGenomeConflict(genomeId, sec.path, JSON.stringify(variants));
        conflicts.push(sec.path);
      } else {
        // incoming dominates — clean update, clear any prior conflict
        finalVclock = mergeVClocks(incomingVclock, storedVclock);
        resolveGenomeConflict(genomeId, sec.path);
        applied.push(sec.path);
      }
    } else {
      applied.push(sec.path);
    }

    const seq = bumpGenomeSeq(genomeId);
    upsertGenomeSection(genomeId, sec.path, finalContent, JSON.stringify(finalVclock), isConflict, seq, isEncrypted);
    logGenomePush(genomeId, clientId, sec.path);
  }

  return c.json({ applied, conflicts });
});

// ---------------------------------------------------------------------------
// GET /genome/:genomeId/pull
// ---------------------------------------------------------------------------

genome.get("/genome/:genomeId/pull", async (c) => {
  const user = c.get("user");
  const deny = requireTier(c, user, "team");
  if (deny) return deny;

  const membership = getTeamForUser(user.id);
  const genomeId = c.req.param("genomeId");
  const g = membership ? requireGenomeAccess(genomeId, membership.team.id) : null;
  if (!g) return c.json({ error: "Genome not found" }, 404);

  const sinceRaw = c.req.query("since");
  const since = sinceRaw !== undefined ? parseInt(sinceRaw, 10) : 0;
  if (isNaN(since) || since < 0) return c.json({ error: "Invalid since parameter" }, 400);

  const rows = getGenomeSectionsSince(genomeId, since);

  const sections = rows.map((r: GenomeSection) => ({
    path:              r.path,
    content:           r.content,
    content_encrypted: r.content_encrypted === 1,
    vclock:            (() => { try { return JSON.parse(r.vclock_json); } catch { return {}; } })(),
    conflictFlag:      r.conflict_flag === 1,
    serverSeq:         r.server_seq,
  }));

  return c.json({ sections, serverSeqNum: g.server_seq });
});

// ---------------------------------------------------------------------------
// GET /genome/:genomeId/conflicts
// ---------------------------------------------------------------------------

genome.get("/genome/:genomeId/conflicts", async (c) => {
  const user = c.get("user");
  const deny = requireTier(c, user, "team");
  if (deny) return deny;

  const membership = getTeamForUser(user.id);
  const genomeId = c.req.param("genomeId");
  const g = membership ? requireGenomeAccess(genomeId, membership.team.id) : null;
  if (!g) return c.json({ error: "Genome not found" }, 404);

  const rows = getGenomeConflicts(genomeId);
  const result = rows.map((r) => ({
    path:     r.path,
    variants: (() => { try { return JSON.parse(r.variants_json); } catch { return []; } })(),
    detectedAt: r.detected_at,
  }));

  return c.json({ conflicts: result });
});

// ---------------------------------------------------------------------------
// POST /genome/:genomeId/resolve
// ---------------------------------------------------------------------------

genome.post("/genome/:genomeId/resolve", async (c) => {
  const user = c.get("user");
  const deny = requireTier(c, user, "team");
  if (deny) return deny;

  const membership = getTeamForUser(user.id);
  const genomeId = c.req.param("genomeId");
  const g = membership ? requireGenomeAccess(genomeId, membership.team.id) : null;
  if (!g) return c.json({ error: "Genome not found" }, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const parsed = ResolveSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);

  const { path, winning } = parsed.data;

  if (!isValidSectionPath(path)) return c.json({ error: "Invalid section path" }, 400);

  const seq = bumpGenomeSeq(genomeId);
  upsertGenomeSection(genomeId, path, winning.content, JSON.stringify(winning.vclock), false, seq, looksEncrypted(winning.content));
  resolveGenomeConflict(genomeId, path);

  return c.json({ ok: true, serverSeq: seq });
});

// ---------------------------------------------------------------------------
// PATCH /genome/:genomeId/settings — org admins can set encryption_required
// ---------------------------------------------------------------------------

const SettingsSchema = z.object({
  encryption_required: z.boolean().optional(),
});

genome.patch("/genome/:genomeId/settings", async (c) => {
  const user = c.get("user");
  const deny = requireTier(c, user, "team");
  if (deny) return deny;

  const membership = getTeamForUser(user.id);

  // Only team admins may change genome settings
  if (!membership || membership.role !== "admin") {
    return c.json({ error: "Admin role required to change genome settings" }, 403);
  }

  const genomeId = c.req.param("genomeId");
  const g = requireGenomeAccess(genomeId, membership.team.id);
  if (!g) return c.json({ error: "Genome not found" }, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const parsed = SettingsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);

  if (parsed.data.encryption_required !== undefined) {
    setEncryptionRequired(genomeId, parsed.data.encryption_required);
  }

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /genome/:genomeId
// ---------------------------------------------------------------------------

genome.delete("/genome/:genomeId", async (c) => {
  const user = c.get("user");
  const deny = requireTier(c, user, "team");
  if (deny) return deny;

  const membership = getTeamForUser(user.id);
  const genomeId = c.req.param("genomeId");
  const g = membership ? requireGenomeAccess(genomeId, membership.team.id) : null;
  if (!g) return c.json({ error: "Genome not found" }, 404);

  deleteGenome(genomeId);
  return c.json({ ok: true });
});

export default genome;
