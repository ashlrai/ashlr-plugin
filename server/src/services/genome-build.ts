/**
 * genome-build.ts — Server-side auto-genome-build from GitHub repos (v1.13 Phase 7B.4).
 *
 * Workflow:
 *  1. Validate tier gating (free users can only build public repos).
 *  2. Upsert a genomes row with build_status='queued'.
 *  3. Return {genomeId, status:'queued'} immediately.
 *  4. Background promise: git clone → genome-init → encrypt sections → UPDATE ready.
 *
 * The build runs in-process as a fire-and-forget promise. A Postgres-backed
 * queue will replace this in v1.14.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  getDb,
  getUserById,
  upsertGenome,
  upsertGenomeSection,
  bumpGenomeSeq,
  getGenomeById,
  getUserGenomeKeyEncrypted,
  setUserGenomeKeyEncrypted,
  updateGenomeBuildStatus,
} from "../db.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { randomBytes, createCipheriv } from "node:crypto";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Per-user AES-256-GCM key management
// ---------------------------------------------------------------------------

/**
 * Get or create the per-user AES-256-GCM key (32 raw bytes).
 * On first call for a user the key is generated, master-key-wrapped via
 * crypto.encrypt, and stored in users.genome_encryption_key_encrypted.
 * Returns the raw key buffer ready for direct use with createCipheriv.
 */
export function getOrCreateUserGenomeKey(userId: string): Buffer {
  let envelope = getUserGenomeKeyEncrypted(userId);
  if (!envelope) {
    const rawKey = randomBytes(32);
    envelope = encrypt(rawKey.toString("base64"));
    setUserGenomeKeyEncrypted(userId, envelope);
    return rawKey;
  }
  return Buffer.from(decrypt(envelope), "base64");
}

/**
 * AES-256-GCM encrypt plaintext with the provided raw key.
 * Wire format (base64): nonce(12) | authTag(16) | ciphertext
 */
export function encryptWithUserKey(plaintext: string, rawKey: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", rawKey, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ct]).toString("base64");
}

// ---------------------------------------------------------------------------
// Custom error types
// ---------------------------------------------------------------------------

export class TierGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TierGateError";
  }
}

export class ScopeUpRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeUpRequiredError";
  }
}

/**
 * Check whether a GitHub access token has `repo` scope by calling the root
 * GitHub API endpoint and reading the `x-oauth-scopes` response header.
 */
async function tokenHasRepoScope(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.github.com/", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "ashlr-server/1.0",
      },
    });
    const scopes = res.headers.get("x-oauth-scopes") ?? "";
    return scopes.split(",").map((s) => s.trim()).includes("repo");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// URL canonicalization
// ---------------------------------------------------------------------------

/**
 * Canonicalize a GitHub repo reference to https://github.com/<owner>/<repo>.
 *
 * Handles:
 *   - https://github.com/Foo/Bar.git        → https://github.com/foo/bar
 *   - git@github.com:Foo/Bar.git            → https://github.com/foo/bar
 *   - https://github.com/foo/bar/           → https://github.com/foo/bar
 *   - plain "owner" + "repo" strings (called as canonicalizeRepoUrl(owner, repo))
 */
export function canonicalizeRepoUrl(owner: string, repo: string): string {
  // Strip .git suffix and trailing slashes, lowercase both
  const o = owner.toLowerCase().replace(/\.git$/, "").replace(/\/$/, "");
  const r = repo.toLowerCase().replace(/\.git$/, "").replace(/\/$/, "");
  return `https://github.com/${o}/${r}`;
}

/**
 * Parse a full GitHub URL or SSH remote into { owner, repo }.
 * Used internally when callers pass a full URL string.
 */
function parseGitHubUrl(raw: string): { owner: string; repo: string } | null {
  // SSH: git@github.com:owner/repo.git
  const ssh = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };

  // HTTPS: https://github.com/owner/repo[.git][/]
  const https = raw.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (https) return { owner: https[1]!, repo: https[2]! };

  return null;
}

// ---------------------------------------------------------------------------
// Tier gate helper
// ---------------------------------------------------------------------------

export async function canBuildGenome(
  userId: string,
  repoVisibility: "public" | "private",
): Promise<{ ok: boolean; reason?: string }> {
  const user = getUserById(userId);
  if (!user) return { ok: false, reason: "User not found" };
  if (repoVisibility === "private" && user.tier === "free") {
    return { ok: false, reason: "free tier can only build public repos; upgrade to Pro for private" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// DB helpers (exposed for route use; could also live in db.ts)
// ---------------------------------------------------------------------------

function upsertPersonalGenome(
  userId: string,
  repoUrl: string,
  repoVisibility: "public" | "private",
  buildStatus: "queued" | "building" | "ready" | "failed",
): string {
  const db = getDb();

  // Check for existing genome for this user+repo
  const existing = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM genomes WHERE owner_user_id = ? AND repo_url = ?`,
    )
    .get(userId, repoUrl);

  if (existing) {
    db.run(
      `UPDATE genomes
         SET build_status = ?, repo_visibility = ?, build_error = NULL,
             last_built_at = NULL
       WHERE id = ?`,
      [buildStatus, repoVisibility, existing.id],
    );
    return existing.id;
  }

  // Use userId as org_id for personal genomes (UNIQUE(org_id, repo_url) enforces one per user+repo)
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO genomes (id, org_id, repo_url, owner_user_id, repo_visibility, build_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, repoUrl, userId, repoVisibility, buildStatus],
  );
  return id;
}

// ---------------------------------------------------------------------------
// Shared build helpers (used by both initial build and webhook-triggered rebuild)
// ---------------------------------------------------------------------------

/** Build an HTTPS clone URL, embedding an access token when available. */
function buildCloneUrl(owner: string, repo: string, githubToken: string | null): string {
  return githubToken
    ? `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`;
}

/**
 * Walk `.ashlrcode/genome/` in a build directory and upsert each section into
 * the genomes table. Private repos are encrypted with the per-user AES-GCM key;
 * public repos are stored as plaintext (no privacy value, avoids decryption
 * round-trip). Returns the number of sections written.
 */
async function upsertGenomeSectionsFromBuild(
  buildDir: string,
  genomeId: string,
  userId: string,
  repoVisibility: "public" | "private",
): Promise<number> {
  const genomeDir = join(buildDir, ".ashlrcode", "genome");
  const files = await readdir(genomeDir).catch(() => [] as string[]);
  const userKey = repoVisibility === "private" ? getOrCreateUserGenomeKey(userId) : null;

  let count = 0;
  for (const file of files) {
    const content = await readFile(join(genomeDir, file), "utf8").catch(() => null);
    if (content === null) continue;

    const storedContent = userKey ? encryptWithUserKey(content, userKey) : content;
    const contentEncrypted = userKey !== null;

    const seq = bumpGenomeSeq(genomeId);
    upsertGenomeSection(genomeId, file, storedContent, "{}", false, seq, contentEncrypted);
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main build function
// ---------------------------------------------------------------------------

export async function buildGenomeFromGitHub(params: {
  userId: string;
  owner: string;
  repo: string;
}): Promise<{ genomeId: string; status: "queued" }> {
  const { userId, owner, repo } = params;

  const user = getUserById(userId);
  if (!user) throw new Error("User not found");

  // Decrypt GitHub token for API + clone auth
  let githubToken: string | null = null;
  if (user.github_access_token_encrypted) {
    try {
      githubToken = decrypt(user.github_access_token_encrypted);
    } catch {
      // Token unusable — proceed without it (public repos only)
    }
  }

  // Call GitHub API to check existence and visibility
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "ashlr-server/1.0",
  };
  if (githubToken) {
    headers["Authorization"] = `Bearer ${githubToken}`;
  }

  const apiRes = await fetch(apiUrl, { headers });

  if (!apiRes.ok) {
    // 404 = doesn't exist or private (no token / no access)
    if (user.tier === "free") {
      throw new TierGateError(
        "free tier can only build public repos; upgrade to Pro for private",
      );
    }
    throw new Error(`GitHub API error: ${apiRes.status}`);
  }

  const repoData = (await apiRes.json()) as { private?: boolean };
  const repoVisibility: "public" | "private" = repoData.private ? "private" : "public";

  // Tier gate: free users cannot build private repos
  if (repoVisibility === "private" && user.tier === "free") {
    throw new TierGateError(
      "free tier can only build public repos; upgrade to Pro for private",
    );
  }

  // Pro/team + private: ensure the stored token has `repo` scope.
  // If it only has `public_repo` scope (Phase 7A default), require step-up consent.
  if (repoVisibility === "private" && githubToken) {
    const hasScope = await tokenHasRepoScope(githubToken);
    if (!hasScope) {
      throw new ScopeUpRequiredError(
        "Private repo requires `repo` scope — ask the user to re-consent at /auth/github/scope-up",
      );
    }
  }

  const canonicalUrl = canonicalizeRepoUrl(owner, repo);

  // Upsert genome row with build_status='queued'
  const genomeId = upsertPersonalGenome(userId, canonicalUrl, repoVisibility, "queued");

  // Fire-and-forget background build
  void runBuildInBackground({ genomeId, userId, owner, repo, githubToken, repoVisibility });

  return { genomeId, status: "queued" };
}

// ---------------------------------------------------------------------------
// Background build implementation
// ---------------------------------------------------------------------------

async function runBuildInBackground(params: {
  genomeId: string;
  userId: string;
  owner: string;
  repo: string;
  githubToken: string | null;
  repoVisibility: "public" | "private";
}): Promise<void> {
  const { genomeId, userId, owner, repo, githubToken, repoVisibility } = params;
  const uuid = crypto.randomUUID();
  const buildDir = `/tmp/ashlr-build/${uuid}`;
  const db = getDb();

  try {
    // Mark as building
    db.run(`UPDATE genomes SET build_status = 'building' WHERE id = ?`, [genomeId]);

    const cloneUrl = buildCloneUrl(owner, repo, githubToken);

    // git clone --depth 1
    try {
      await execFile(
        "git",
        ["clone", "--depth", "1", cloneUrl, buildDir],
        { timeout: 60_000 },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const truncated = msg.slice(0, 500);
      db.run(
        `UPDATE genomes SET build_status = 'failed', build_error = ? WHERE id = ?`,
        [truncated, genomeId],
      );
      return;
    }

    // bun run scripts/genome-init.ts --dir <buildDir> --minimal
    const scriptPath = join(import.meta.dir, "../../../scripts/genome-init.ts");
    try {
      await execFile(
        "bun",
        ["run", scriptPath, "--dir", buildDir, "--minimal"],
        { timeout: 120_000 },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Prefer stderr if available
      const detail =
        (err as { stderr?: string }).stderr?.slice(0, 500) ??
        msg.slice(0, 500);
      db.run(
        `UPDATE genomes SET build_status = 'failed', build_error = ? WHERE id = ?`,
        [detail, genomeId],
      );
      return;
    }

    await upsertGenomeSectionsFromBuild(buildDir, genomeId, userId, repoVisibility);

    // Mark ready
    db.run(
      `UPDATE genomes SET build_status = 'ready', last_built_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), build_error = NULL WHERE id = ?`,
      [genomeId],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    db.run(
      `UPDATE genomes SET build_status = 'failed', build_error = ? WHERE id = ?`,
      [msg.slice(0, 500), genomeId],
    );
  } finally {
    // Always clean up the temp directory
    await rm(buildDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Delta rebuild (v1.14 — called by webhook handler on push events)
// ---------------------------------------------------------------------------

/**
 * Rebuild a genome triggered by a GitHub push event.
 *
 * MVP: full re-index on every push (true per-file delta is v1.15).
 * The "delta" value here is that:
 *   - We skip the rebuild if no relevant files changed (future: file filter).
 *   - We diff HEAD~1..HEAD to produce a short change summary stored on the genome.
 *   - Build status flows queued → building → ready/failed exactly like initial build.
 *
 * Returns {sectionsUpdated, durationMs, changeSummary}.
 */
export async function rebuildGenomeDelta(params: {
  userId: string;
  owner: string;
  repo: string;
  genomeId: string;
  changedFiles: string[];
}): Promise<{ sectionsUpdated: number; durationMs: number; changeSummary: string }> {
  const { userId, owner, repo, genomeId } = params;
  const start = Date.now();
  const uuid = crypto.randomUUID();
  const buildDir = `/tmp/ashlr-delta/${uuid}`;
  const db = getDb();

  const user = getUserById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);

  // Decrypt GitHub token if available
  let githubToken: string | null = null;
  if (user.github_access_token_encrypted) {
    try {
      githubToken = decrypt(user.github_access_token_encrypted);
    } catch { /* proceed without token */ }
  }

  // Determine repo visibility from existing genome row
  const genome = getGenomeById(genomeId);
  const repoVisibility: "public" | "private" = genome?.repo_visibility ?? "public";

  updateGenomeBuildStatus(genomeId, "queued");

  try {
    updateGenomeBuildStatus(genomeId, "building");

    const cloneUrl = buildCloneUrl(owner, repo, githubToken);

    // Shallow clone (depth=2 so we can diff HEAD~1..HEAD)
    try {
      await execFile(
        "git",
        ["clone", "--depth", "2", cloneUrl, buildDir],
        { timeout: 60_000 },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateGenomeBuildStatus(genomeId, "failed", msg.slice(0, 500));
      throw err;
    }

    // Generate change summary from git diff
    let changeSummary = "";
    try {
      const { stdout } = await execFile(
        "git",
        ["diff", "--name-only", "HEAD~1", "HEAD"],
        { cwd: buildDir, timeout: 10_000 },
      );
      const diffFiles = stdout.trim().split("\n").filter(Boolean);
      changeSummary = diffFiles.length > 0
        ? `${diffFiles.length} file(s) changed: ${diffFiles.slice(0, 5).join(", ")}${diffFiles.length > 5 ? "…" : ""}`
        : "no file changes detected";
    } catch {
      changeSummary = "diff unavailable (shallow clone)";
    }

    // Run genome-init --minimal
    const scriptPath = join(import.meta.dir, "../../../scripts/genome-init.ts");
    try {
      await execFile(
        "bun",
        ["run", scriptPath, "--dir", buildDir, "--minimal"],
        { timeout: 120_000 },
      );
    } catch (err: unknown) {
      const detail =
        (err as { stderr?: string }).stderr?.slice(0, 500) ??
        (err instanceof Error ? err.message : String(err)).slice(0, 500);
      updateGenomeBuildStatus(genomeId, "failed", detail);
      throw err;
    }

    const sectionsUpdated = await upsertGenomeSectionsFromBuild(
      buildDir,
      genomeId,
      userId,
      repoVisibility,
    );

    // Persist change summary on genome row
    db.run(
      `UPDATE genomes SET last_change_summary = ? WHERE id = ?`,
      [changeSummary, genomeId],
    );

    updateGenomeBuildStatus(genomeId, "ready");

    const durationMs = Date.now() - start;
    return { sectionsUpdated, durationMs, changeSummary };
  } finally {
    await rm(buildDir, { recursive: true, force: true }).catch(() => {});
  }
}
