/**
 * db/genome.ts — Genomes, genome sections, conflicts, policy packs,
 *               audit events, and webhook events.
 *
 * Extracted from db.ts as part of Track C decomposition (v1.24).
 */

import type { SQLQueryBindings } from "bun:sqlite";
import { getDb } from "./connection";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Genome {
  id: string;
  org_id: string;
  repo_url: string;
  created_at: string;
  server_seq: number;
  encryption_required: number; // 0 = false, 1 = true
  // Phase 7B personal-genome columns — all NULL/ready for legacy team rows.
  owner_user_id: string | null;
  repo_visibility: "public" | "private" | null;
  build_status: "queued" | "building" | "ready" | "failed";
  build_error: string | null;
  last_built_at: string | null;
}

export interface GenomeSection {
  id: string;
  genome_id: string;
  path: string;
  content: string;
  vclock_json: string;
  conflict_flag: number;
  content_encrypted: number; // 0 = plaintext, 1 = AES-256-GCM ciphertext blob
  server_seq: number;
  updated_at: string;
}

export interface GenomeConflict {
  id: string;
  genome_id: string;
  path: string;
  variants_json: string;
  detected_at: string;
}

export interface GenomePubkey {
  pubkey: string; // base64url-encoded 32-byte X25519 public key
  alg:    string; // e.g. "x25519-v1"
}

export interface KeyEnvelope {
  id:              string;
  genome_id:       string;
  member_user_id:  string;
  wrapped_dek:     string;
  alg:             string;
  created_by:      string;
  created_at:      string;
  revoked_at:      string | null;
}

export interface PolicyRule {
  match: string;
  kind: "tool" | "path" | "shell";
  reason?: string;
}

export interface PolicyRules {
  allow: PolicyRule[];
  deny: PolicyRule[];
  requireConfirm: PolicyRule[];
}

export interface PolicyPack {
  id: string;
  org_id: string;
  name: string;
  version: number;
  rules_json: string;
  author: string;
  created_at: string;
}

export interface PolicyCurrent {
  org_id: string;
  pack_id: string;
  set_at: string;
}

export interface AuditEvent {
  id: string;
  org_id: string;
  user_id: string;
  tool: string;
  args_json: string;
  cwd_fingerprint: string;
  git_commit: string;
  at: string;
}

export interface AppendAuditEventParams {
  orgId: string;
  userId: string;
  tool: string;
  argsJson: string;
  cwdFingerprint: string;
  gitCommit: string;
  at?: string;
}

export interface QueryAuditEventsParams {
  orgId: string;
  from?: string;
  to?: string;
  userId?: string;
  tool?: string;
  limit?: number;
  offset?: number;
}

export interface WebhookEvent {
  id: string;
  event_type: string;
  genome_id: string | null;
  commit_sha: string | null;
  processed_at: string;
  status: string;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Genome CRUD
// ---------------------------------------------------------------------------

/** Create or return an existing genome for (orgId, repoUrl). Returns {genome, created}. */
export function upsertGenome(orgId: string, repoUrl: string): { genome: Genome; created: boolean } {
  const db = getDb();
  const existing = db.query<Genome, [string, string]>(
    `SELECT id, org_id, repo_url, created_at, server_seq FROM genomes WHERE org_id = ? AND repo_url = ?`,
  ).get(orgId, repoUrl);
  if (existing) return { genome: existing, created: false };

  const id = crypto.randomUUID();
  db.run(`INSERT INTO genomes (id, org_id, repo_url) VALUES (?, ?, ?)`, [id, orgId, repoUrl]);
  return { genome: db.query<Genome, [string]>(`SELECT * FROM genomes WHERE id = ?`).get(id)!, created: true };
}

export function getGenomeById(id: string): Genome | null {
  return getDb().query<Genome, [string]>(`SELECT * FROM genomes WHERE id = ?`).get(id);
}

/**
 * Load a genome only if it belongs to the given team.
 * Returns null when the genome doesn't exist OR the team doesn't own it —
 * callers should always respond 404 so existence isn't leaked to unauthorized callers.
 *
 * Safety invariant: `teamId` must be a non-empty string. Post-v1.11.1 rows
 * always have `org_id = <real team id>` because `/genome/init` sources it
 * from `getTeamForUser`. Pre-v1.11.1 rows may carry an empty or attacker-
 * supplied `org_id` — we reject empty `teamId` explicitly so a future caller
 * that defaults to `?? ""` can't reach the query and accidentally match a
 * legacy blank-org row.
 */
export function requireGenomeAccess(id: string, teamId: string): Genome | null {
  if (!teamId) return null;
  const g = getDb()
    .query<Genome, [string, string]>(`SELECT * FROM genomes WHERE id = ? AND org_id = ?`)
    .get(id, teamId);
  return g ?? null;
}

export function deleteGenome(id: string): void {
  getDb().run(`DELETE FROM genomes WHERE id = ?`, [id]);
}

/** Atomically bump server_seq on genome and return the new value. */
export function bumpGenomeSeq(genomeId: string): number {
  const db = getDb();
  db.run(`UPDATE genomes SET server_seq = server_seq + 1 WHERE id = ?`, [genomeId]);
  const row = db.query<{ server_seq: number }, [string]>(
    `SELECT server_seq FROM genomes WHERE id = ?`,
  ).get(genomeId);
  return row!.server_seq;
}

/** Upsert a genome section. Returns the stored section. */
export function upsertGenomeSection(
  genomeId: string,
  path: string,
  content: string,
  vclockJson: string,
  conflictFlag: boolean,
  serverSeq: number,
  contentEncrypted = false,
): GenomeSection {
  const db = getDb();
  const existing = db.query<GenomeSection, [string, string]>(
    `SELECT * FROM genome_sections WHERE genome_id = ? AND path = ?`,
  ).get(genomeId, path);

  if (existing) {
    db.run(
      `UPDATE genome_sections SET content = ?, vclock_json = ?, conflict_flag = ?, content_encrypted = ?, server_seq = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE genome_id = ? AND path = ?`,
      [content, vclockJson, conflictFlag ? 1 : 0, contentEncrypted ? 1 : 0, serverSeq, genomeId, path],
    );
  } else {
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO genome_sections (id, genome_id, path, content, vclock_json, conflict_flag, content_encrypted, server_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, genomeId, path, content, vclockJson, conflictFlag ? 1 : 0, contentEncrypted ? 1 : 0, serverSeq],
    );
  }

  return db.query<GenomeSection, [string, string]>(
    `SELECT * FROM genome_sections WHERE genome_id = ? AND path = ?`,
  ).get(genomeId, path)!;
}

/** Set the encryption_required flag on a genome (org admins only). */
export function setEncryptionRequired(genomeId: string, required: boolean): void {
  getDb().run(
    `UPDATE genomes SET encryption_required = ? WHERE id = ?`,
    [required ? 1 : 0, genomeId],
  );
}

export function getGenomeSectionsSince(genomeId: string, since: number): GenomeSection[] {
  return getDb().query<GenomeSection, [string, number]>(
    `SELECT * FROM genome_sections WHERE genome_id = ? AND server_seq > ? ORDER BY server_seq ASC`,
  ).all(genomeId, since);
}

export function getGenomeSectionByPath(genomeId: string, path: string): GenomeSection | null {
  return getDb().query<GenomeSection, [string, string]>(
    `SELECT * FROM genome_sections WHERE genome_id = ? AND path = ?`,
  ).get(genomeId, path);
}

/** Insert or replace a conflict record for a path (one active conflict per path). */
export function upsertGenomeConflict(
  genomeId: string,
  path: string,
  variantsJson: string,
): void {
  const db = getDb();
  // Remove any existing conflict for this path first
  db.run(`DELETE FROM genome_conflicts WHERE genome_id = ? AND path = ?`, [genomeId, path]);
  db.run(
    `INSERT INTO genome_conflicts (id, genome_id, path, variants_json)
     VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), genomeId, path, variantsJson],
  );
}

export function getGenomeConflicts(genomeId: string): GenomeConflict[] {
  return getDb().query<GenomeConflict, [string]>(
    `SELECT * FROM genome_conflicts WHERE genome_id = ? ORDER BY detected_at DESC`,
  ).all(genomeId);
}

export function resolveGenomeConflict(genomeId: string, path: string): void {
  getDb().run(
    `DELETE FROM genome_conflicts WHERE genome_id = ? AND path = ?`,
    [genomeId, path],
  );
}

export function logGenomePush(genomeId: string, clientId: string, path: string): void {
  getDb().run(
    `INSERT INTO genome_push_log (id, genome_id, client_id, path) VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), genomeId, clientId, path],
  );
}

// ---------------------------------------------------------------------------
// v2 envelope encryption — per-user X25519 pubkey + per-member wrapped DEKs.
//
// Server stores opaque wrapped-DEK envelopes. Wrapping and unwrapping happen
// exclusively on the client — server cannot read the plaintext DEK or
// genome content.
// ---------------------------------------------------------------------------

/** Upsert the caller's X25519 public key (idempotent; identical key is a no-op). */
export function setUserGenomePubkey(userId: string, pubkey: string, alg: string): void {
  getDb().run(
    `UPDATE users SET genome_pubkey_x25519 = ?, genome_pubkey_alg = ? WHERE id = ?`,
    [pubkey, alg, userId],
  );
}

export function getUserGenomePubkey(userId: string): GenomePubkey | null {
  const row = getDb()
    .query<{ pubkey: string | null; alg: string | null }, [string]>(
      `SELECT genome_pubkey_x25519 AS pubkey, genome_pubkey_alg AS alg FROM users WHERE id = ?`,
    )
    .get(userId);
  if (!row || !row.pubkey || !row.alg) return null;
  return { pubkey: row.pubkey, alg: row.alg };
}

/**
 * Store a wrapped DEK for one (genome, member) pair. Re-uploading replaces
 * the stored envelope (e.g. re-wrapping after a key rotation). Caller MUST
 * have already verified that `createdBy` is an admin of the team that owns
 * `genomeId` — not enforced at the DB layer.
 */
export function upsertKeyEnvelope(params: {
  genomeId:     string;
  memberUserId: string;
  wrappedDek:   string;
  alg:          string;
  createdBy:    string;
}): KeyEnvelope {
  const db = getDb();
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO genome_key_envelopes
       (id, genome_id, member_user_id, wrapped_dek, alg, created_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(genome_id, member_user_id) DO UPDATE SET
       wrapped_dek = excluded.wrapped_dek,
       alg         = excluded.alg,
       created_by  = excluded.created_by,
       created_at  = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       revoked_at  = NULL`,
    [id, params.genomeId, params.memberUserId, params.wrappedDek, params.alg, params.createdBy],
  );
  const row = db
    .query<KeyEnvelope, [string, string]>(
      `SELECT id, genome_id, member_user_id, wrapped_dek, alg, created_by, created_at, revoked_at
         FROM genome_key_envelopes
        WHERE genome_id = ? AND member_user_id = ?`,
    )
    .get(params.genomeId, params.memberUserId);
  if (!row) throw new Error("upsertKeyEnvelope: row missing after insert");
  return row;
}

/** Fetch the caller's own wrapped DEK. Returns null when revoked or absent. */
export function getKeyEnvelopeForMember(
  genomeId: string,
  memberUserId: string,
): KeyEnvelope | null {
  return getDb()
    .query<KeyEnvelope, [string, string]>(
      `SELECT id, genome_id, member_user_id, wrapped_dek, alg, created_by, created_at, revoked_at
         FROM genome_key_envelopes
        WHERE genome_id = ? AND member_user_id = ? AND revoked_at IS NULL`,
    )
    .get(genomeId, memberUserId) ?? null;
}

/** Admin view: every active envelope for a genome (for re-wrap / audit). */
export function listKeyEnvelopesForGenome(genomeId: string): KeyEnvelope[] {
  return getDb()
    .query<KeyEnvelope, [string]>(
      `SELECT id, genome_id, member_user_id, wrapped_dek, alg, created_by, created_at, revoked_at
         FROM genome_key_envelopes
        WHERE genome_id = ? AND revoked_at IS NULL
        ORDER BY created_at ASC`,
    )
    .all(genomeId);
}

/** Soft-revoke. Re-upserting with a fresh wrapped_dek clears the revocation. */
export function revokeKeyEnvelope(genomeId: string, memberUserId: string): void {
  getDb().run(
    `UPDATE genome_key_envelopes
        SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE genome_id = ? AND member_user_id = ?`,
    [genomeId, memberUserId],
  );
}

/** Count push events for a clientId within the last windowMs milliseconds. */
export function countRecentGenomePushes(genomeId: string, clientId: string, windowMs: number): number {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = getDb().query<{ n: number }, [string, string, string]>(
    `SELECT COUNT(*) AS n FROM genome_push_log WHERE genome_id = ? AND client_id = ? AND at >= ?`,
  ).get(genomeId, clientId, since);
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Personal genome helpers (Phase 7B.4)
// ---------------------------------------------------------------------------

/** Look up a personal genome by owner user and canonical repo URL. */
export function getPersonalGenomeForUser(userId: string, repoUrl: string): Genome | null {
  return getDb()
    .query<Genome, [string, string]>(
      `SELECT * FROM genomes WHERE owner_user_id = ? AND repo_url = ?`,
    )
    .get(userId, repoUrl) ?? null;
}

/**
 * Look up a personal genome by canonical repo URL (any owner).
 * Used by the webhook handler which doesn't know the user upfront.
 */
export function getPersonalGenomeByRepoUrl(repoUrl: string): Genome | null {
  return getDb()
    .query<Genome, [string]>(
      `SELECT * FROM genomes WHERE repo_url = ? AND owner_user_id IS NOT NULL LIMIT 1`,
    )
    .get(repoUrl) ?? null;
}

/** List all personal genomes owned by a user, newest first. */
export function listPersonalGenomesForUser(userId: string): Genome[] {
  return getDb()
    .query<Genome, [string]>(
      `SELECT * FROM genomes WHERE owner_user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId);
}

/** Update build status (and optionally build_error) for a genome. */
export function updateGenomeBuildStatus(
  genomeId: string,
  status: "queued" | "building" | "ready" | "failed",
  error?: string | null,
): void {
  const db = getDb();
  if (status === "ready") {
    db.run(
      `UPDATE genomes SET build_status = 'ready', last_built_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), build_error = NULL WHERE id = ?`,
      [genomeId],
    );
  } else if (error !== undefined) {
    db.run(
      `UPDATE genomes SET build_status = ?, build_error = ? WHERE id = ?`,
      [status, error ?? null, genomeId],
    );
  } else {
    db.run(`UPDATE genomes SET build_status = ? WHERE id = ?`, [status, genomeId]);
  }
}

// ---------------------------------------------------------------------------
// Policy pack helpers (Phase 4)
// ---------------------------------------------------------------------------

/** Insert a new policy pack version. Returns the new pack. */
export function createPolicyPack(
  orgId: string,
  name: string,
  rules: PolicyRules,
  author: string,
): PolicyPack {
  const db = getDb();
  // Determine next version number for this (org, name) pair.
  const row = db.query<{ max_v: number | null }, [string, string]>(
    `SELECT MAX(version) AS max_v FROM policy_packs WHERE org_id = ? AND name = ?`,
  ).get(orgId, name);
  const version = (row?.max_v ?? 0) + 1;
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO policy_packs (id, org_id, name, version, rules_json, author)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, orgId, name, version, JSON.stringify(rules), author],
  );
  // Update current pointer
  db.run(
    `INSERT INTO policy_current (org_id, pack_id, set_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(org_id) DO UPDATE SET pack_id = excluded.pack_id, set_at = excluded.set_at`,
    [orgId, id],
  );
  return getPolicyPackById(id)!;
}

export function getPolicyPackById(id: string): PolicyPack | null {
  return getDb()
    .query<PolicyPack, [string]>(`SELECT * FROM policy_packs WHERE id = ?`)
    .get(id);
}

export function getCurrentPolicyPack(orgId: string): PolicyPack | null {
  const db = getDb();
  const cur = db.query<PolicyCurrent, [string]>(
    `SELECT * FROM policy_current WHERE org_id = ?`,
  ).get(orgId);
  if (!cur) return null;
  return getPolicyPackById(cur.pack_id);
}

export function getPolicyPackHistory(orgId: string, limit = 20): PolicyPack[] {
  return getDb()
    .query<PolicyPack, [string, number]>(
      `SELECT * FROM policy_packs WHERE org_id = ? ORDER BY version DESC LIMIT ?`,
    )
    .all(orgId, limit);
}

export function getPolicyPackByVersion(orgId: string, name: string, version: number): PolicyPack | null {
  return getDb()
    .query<PolicyPack, [string, string, number]>(
      `SELECT * FROM policy_packs WHERE org_id = ? AND name = ? AND version = ?`,
    )
    .get(orgId, name, version);
}

/** Set a specific pack as the current one (for rollback). */
export function setCurrentPolicyPack(orgId: string, packId: string): void {
  getDb().run(
    `INSERT INTO policy_current (org_id, pack_id, set_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(org_id) DO UPDATE SET pack_id = excluded.pack_id, set_at = excluded.set_at`,
    [orgId, packId],
  );
}

// ---------------------------------------------------------------------------
// Audit event helpers (Phase 4)
// ---------------------------------------------------------------------------

/** Append an immutable audit event. Returns the event id. */
export function appendAuditEvent(params: AppendAuditEventParams): string {
  const id = crypto.randomUUID();
  const at = params.at ?? new Date().toISOString();
  getDb().run(
    `INSERT INTO audit_events (id, org_id, user_id, tool, args_json, cwd_fingerprint, git_commit, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, params.orgId, params.userId, params.tool, params.argsJson, params.cwdFingerprint, params.gitCommit, at],
  );
  return id;
}

export function queryAuditEvents(params: QueryAuditEventsParams): AuditEvent[] {
  const db = getDb();
  const conditions: string[] = ["org_id = ?"];
  const bindings: SQLQueryBindings[] = [params.orgId];

  if (params.from) { conditions.push("at >= ?"); bindings.push(params.from); }
  if (params.to)   { conditions.push("at <= ?"); bindings.push(params.to); }
  if (params.userId) { conditions.push("user_id = ?"); bindings.push(params.userId); }
  if (params.tool)   { conditions.push("tool = ?"); bindings.push(params.tool); }

  const limit  = params.limit  ?? 100;
  const offset = params.offset ?? 0;
  bindings.push(limit, offset);

  const sql = `SELECT * FROM audit_events WHERE ${conditions.join(" AND ")} ORDER BY at DESC LIMIT ? OFFSET ?`;
  return db.query<AuditEvent, SQLQueryBindings[]>(sql).all(...bindings);
}

/** Stream all audit events for an org in ascending time order (for NDJSON export). */
export function streamAuditEvents(orgId: string): AuditEvent[] {
  return getDb()
    .query<AuditEvent, [string]>(
      `SELECT * FROM audit_events WHERE org_id = ? ORDER BY at ASC`,
    )
    .all(orgId);
}

// ---------------------------------------------------------------------------
// Webhook event helpers (v1.14)
// ---------------------------------------------------------------------------

export function recordWebhookEvent(params: {
  id: string;
  event_type: string;
  genome_id?: string | null;
  commit_sha?: string | null;
  status: string;
  error?: string | null;
}): { inserted: boolean } {
  // INSERT OR IGNORE on the UNIQUE id so a concurrent replay can't produce
  // duplicate rows. Return .inserted so callers can decide "new delivery —
  // run the rebuild" vs "duplicate — skip" atomically, without a prior
  // hasProcessedDelivery SELECT (which was TOCTOU-racey against GitHub
  // retries arriving before the first insert committed).
  const result = getDb().run(
    `INSERT OR IGNORE INTO webhook_events (id, event_type, genome_id, commit_sha, status, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      params.id,
      params.event_type,
      params.genome_id ?? null,
      params.commit_sha ?? null,
      params.status,
      params.error ?? null,
    ],
  );
  return { inserted: result.changes > 0 };
}

/**
 * Returns true if this delivery id has already been recorded.
 * Primary dedup check — faster than (genomeId, commitSha) because delivery ids
 * are globally unique per GitHub webhook delivery.
 */
export function hasProcessedDelivery(deliveryId: string): boolean {
  const row = getDb()
    .query<{ id: string }, [string]>(`SELECT id FROM webhook_events WHERE id = ?`)
    .get(deliveryId);
  return row !== null;
}

/**
 * Returns true if this (genomeId, commitSha) pair has already been processed
 * successfully. Used as a secondary dedup for cases where the delivery id
 * changed (e.g. manual re-delivery with a new id).
 */
export function hasProcessedCommit(genomeId: string, commitSha: string): boolean {
  const row = getDb()
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM webhook_events
       WHERE genome_id = ? AND commit_sha = ? AND status = 'processed' LIMIT 1`,
    )
    .get(genomeId, commitSha);
  return row !== null;
}

export function updateWebhookEventStatus(
  id: string,
  status: "received" | "processed" | "skipped" | "failed",
  error?: string,
): void {
  getDb().run(
    `UPDATE webhook_events SET status = ?, error = ? WHERE id = ?`,
    [status, error ?? null, id],
  );
}
