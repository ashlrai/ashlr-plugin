/**
 * genome-cloud-pull — pull a cloud-built genome for the current repo.
 *
 * Called from hooks/session-start.ts as a best-effort, fire-and-forget step.
 * Never throws. Always exits 0 (when run as a script). The whole thing is
 * wrapped in a top-level try/catch so a network error or bad response can
 * never break session-start.
 *
 * Auth: reads ~/.ashlr/pro-token (file mode 0o600). Absent or empty → no-op.
 * Kill switch: ASHLR_CLOUD_GENOME_DISABLE=1 → silent no-op.
 *
 * Phase 7B MVP: assumes contentEncrypted=0 (plaintext sections).
 * Phase 7C will add per-user AES-GCM key negotiation.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { createHash, createDecipheriv } from "crypto";

const API_URL = process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";
const ASHLR_DIR = join(homedir(), ".ashlr");

// ---------------------------------------------------------------------------
// URL canonicalization — must match Phase 7B.4 server-side rules exactly.
// ---------------------------------------------------------------------------

/**
 * Normalize a git remote URL to a canonical https form:
 *   - lowercase host + path
 *   - strip trailing .git
 *   - strip trailing /
 *   - convert ssh `git@github.com:foo/bar` → `https://github.com/foo/bar`
 *
 * Exported so tests and server-side can share the same fixture.
 */
export function canonicalizeRepoUrl(raw: string): string {
  let url = raw.trim();

  // Convert SSH shorthand: git@github.com:owner/repo[.git]
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    url = `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  // Lowercase everything
  url = url.toLowerCase();

  // Strip trailing / first, then .git, then trailing / again
  // (handles cases like "repo.git/" where slash comes after .git)
  url = url.replace(/\/+$/, "");
  if (url.endsWith(".git")) {
    url = url.slice(0, -4);
  }
  url = url.replace(/\/+$/, "");

  return url;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readProToken(): string {
  try {
    const tokenPath = join(ASHLR_DIR, "pro-token");
    const token = readFileSync(tokenPath, "utf-8").trim();
    return token;
  } catch {
    return "";
  }
}

function getGitRemote(cwd: string): string {
  try {
    const res = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd,
      timeout: 2000,
      encoding: "utf-8",
    });
    if (res.status !== 0 || !res.stdout) return "";
    return res.stdout.trim();
  } catch {
    return "";
  }
}

function projectHash(canonUrl: string): string {
  return createHash("sha256").update(canonUrl).digest("hex").slice(0, 8);
}

interface GenomeFindResponse {
  genomeId: string;
  status: string;
  builtAt: string;
  visibility: string;
}

interface GenomeSection {
  path: string;
  content: string;
  vclock: number;
  contentEncrypted: number;
}

interface GenomePullResponse {
  sections: GenomeSection[];
  serverSeq: number;
}

interface CloudGenomeMarker {
  repoUrl: string;
  genomeId: string;
  builtAt: string;
  pulledAt: string;
  serverSeq: number;
}

/**
 * Decrypt a section encrypted by encryptWithUserKey (nonce|tag|ct, base64).
 * rawKey is the 32-byte Buffer from the user genome-key endpoint.
 */
function decryptSection(encryptedBase64: string, rawKey: Buffer): string {
  const buf = Buffer.from(encryptedBase64, "base64");
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", rawKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * Fetch the per-user genome key from the server and cache it at
 * ~/.ashlr/genome-key (mode 0o600). Returns the raw 32-byte Buffer,
 * or null if the request fails.
 */
async function fetchAndCacheGenomeKey(
  token: string,
  home: string,
  doFetch: FetchFn,
): Promise<Buffer | null> {
  const keyPath = join(home, ".ashlr", "genome-key");

  // Try cached copy first
  try {
    const cached = readFileSync(keyPath, "utf-8").trim();
    if (cached) return Buffer.from(cached, "base64");
  } catch {
    // not cached yet
  }

  try {
    const res = await doFetch(`${API_URL}/user/genome-key`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json() as { key?: string };
    if (!body.key) return null;
    // Cache to disk at 0o600
    writeFileSync(keyPath, body.key, { encoding: "utf-8", mode: 0o600 });
    try { chmodSync(keyPath, 0o600); } catch { /* best-effort */ }
    return Buffer.from(body.key, "base64");
  } catch {
    return null;
  }
}

function emitEvent(event: Record<string, unknown>, ashlrDir: string = ASHLR_DIR): void {
  try {
    const logPath = join(ashlrDir, "session-log.jsonl");
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  } catch {
    /* log is decoration — never throw */
  }
}

// ---------------------------------------------------------------------------
// Main pull function
// ---------------------------------------------------------------------------

/**
 * Pull the cloud genome for the current repo into ~/.ashlr/genomes/<hash>/.
 *
 * Semantics:
 *  - No-op (silent) when: kill switch set, no pro-token, not a git repo,
 *    no remote, API 404, network error.
 *  - Logs one line to stderr when genome is still building.
 *  - Writes sections + marker file on success.
 *
 * @param opts - Dependency injection for testing (cwd, fetch, spawnSync).
 */
type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function runCloudPull(opts?: {
  cwd?: string;
  fetchFn?: FetchFn;
  spawnFn?: typeof spawnSync;
  home?: string;
}): Promise<void> {
  try {
    // Kill switch
    if (process.env["ASHLR_CLOUD_GENOME_DISABLE"] === "1") return;

    const home = opts?.home ?? homedir();
    const cwd = opts?.cwd ?? process.cwd();
    const doFetch: FetchFn = opts?.fetchFn ?? fetch;
    const doSpawn = opts?.spawnFn ?? spawnSync;

    // Read pro-token
    let token: string;
    try {
      const tokenPath = join(home, ".ashlr", "pro-token");
      token = readFileSync(tokenPath, "utf-8").trim();
    } catch {
      return; // no token file → silent exit
    }
    if (!token) return;

    // Get git remote
    let rawRemote: string;
    try {
      const res = doSpawn("git", ["remote", "get-url", "origin"], {
        cwd,
        timeout: 2000,
        encoding: "utf-8",
      });
      if (res.status !== 0 || !res.stdout) return;
      rawRemote = (res.stdout as string).trim();
    } catch {
      return; // not a git repo → silent exit
    }
    if (!rawRemote) return;

    const canonUrl = canonicalizeRepoUrl(rawRemote);
    const hash = projectHash(canonUrl);
    const genomeDir = join(home, ".ashlr", "genomes", hash);

    // Find genome by repo URL
    let findRes: Response;
    try {
      findRes = await doFetch(
        `${API_URL}/genome/personal/find?repo_url=${encodeURIComponent(canonUrl)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch {
      return; // network error → silent exit
    }

    if (findRes.status === 404) return; // no genome for this repo → silent exit
    if (!findRes.ok) return; // other error → silent exit

    const findData = (await findRes.json()) as GenomeFindResponse;
    const { genomeId, status, builtAt } = findData;

    if (status !== "ready") {
      process.stderr.write(
        "[ashlr] cloud genome still building; will check again next session\n",
      );
      return;
    }

    // Pull sections
    let pullRes: Response;
    try {
      pullRes = await doFetch(
        `${API_URL}/genome/${genomeId}/pull?since=0`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch {
      return; // network error → silent exit
    }
    if (!pullRes.ok) return;

    const pullData = (await pullRes.json()) as GenomePullResponse;
    const { sections, serverSeq } = pullData;

    // Write sections to disk
    mkdirSync(genomeDir, { recursive: true });

    // Fetch per-user key lazily — only if any section is encrypted
    const hasEncrypted = sections.some((s) => s.contentEncrypted === 1);
    let userKey: Buffer | null = null;
    if (hasEncrypted) {
      userKey = await fetchAndCacheGenomeKey(token, home, doFetch);
      if (!userKey) {
        process.stderr.write(
          "[ashlr] could not fetch genome decryption key — skipping encrypted sections\n",
        );
      }
    }

    for (const section of sections) {
      let content: string;
      if (section.contentEncrypted === 1) {
        if (!userKey) continue; // skip — key unavailable
        try {
          content = decryptSection(section.content, userKey);
        } catch {
          process.stderr.write(
            `[ashlr] failed to decrypt section ${section.path} — skipping\n`,
          );
          continue;
        }
      } else {
        content = section.content;
      }

      const sectionPath = join(genomeDir, section.path);
      // Use `dirname` instead of indexOf("/") — on Windows join() emits
      // backslashes so a slash-based split returns -1 and mkdir is skipped,
      // causing ENOENT on the subsequent writeFileSync.
      const sectionDir = dirname(sectionPath);
      if (sectionDir && sectionDir !== genomeDir) {
        mkdirSync(sectionDir, { recursive: true });
      }
      writeFileSync(sectionPath, content, "utf-8");
    }

    // Write marker file
    const marker: CloudGenomeMarker = {
      repoUrl: canonUrl,
      genomeId,
      builtAt,
      pulledAt: new Date().toISOString(),
      serverSeq,
    };
    writeFileSync(join(genomeDir, ".ashlr-cloud-genome"), JSON.stringify(marker, null, 2), "utf-8");

    // Emit event
    emitEvent({
      event: "cloud_genome_pulled",
      genomeId,
      sections: sections.length,
    }, join(home, ".ashlr"));
  } catch (err) {
    // Never propagate — session-start must always succeed.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ashlr] cloud genome pull failed: ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// Script entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await runCloudPull();
  process.exit(0);
}
