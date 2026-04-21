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
} from "../db.js";
import { encrypt } from "../lib/crypto.js";
import { decrypt } from "../lib/crypto.js";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Custom error types
// ---------------------------------------------------------------------------

export class TierGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TierGateError";
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

  const canonicalUrl = canonicalizeRepoUrl(owner, repo);

  // Upsert genome row with build_status='queued'
  const genomeId = upsertPersonalGenome(userId, canonicalUrl, repoVisibility, "queued");

  // Fire-and-forget background build
  void runBuildInBackground({ genomeId, userId, owner, repo, githubToken });

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
}): Promise<void> {
  const { genomeId, owner, repo, githubToken } = params;
  const uuid = crypto.randomUUID();
  const buildDir = `/tmp/ashlr-build/${uuid}`;
  const db = getDb();

  try {
    // Mark as building
    db.run(`UPDATE genomes SET build_status = 'building' WHERE id = ?`, [genomeId]);

    // Build clone URL — use token for auth if available
    const cloneUrl = githubToken
      ? `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`
      : `https://github.com/${owner}/${repo}.git`;

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

    // Walk .ashlrcode/genome/ and upsert encrypted sections
    const genomeDir = join(buildDir, ".ashlrcode", "genome");
    const files = await readdir(genomeDir).catch(() => [] as string[]);

    for (const file of files) {
      const filePath = join(genomeDir, file);
      const content = await readFile(filePath, "utf8").catch(() => null);
      if (content === null) continue;

      const encryptedContent = encrypt(content);
      const seq = bumpGenomeSeq(genomeId);
      upsertGenomeSection(
        genomeId,
        file,
        encryptedContent,
        "{}",
        false,
        seq,
        true, // contentEncrypted
      );
    }

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
