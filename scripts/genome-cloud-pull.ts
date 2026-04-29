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
 * Pull modes:
 *   - Team genome  (.cloud-id present in .ashlrcode/genome/): v2 envelope path.
 *     Fetches the caller's wrapped DEK via GET /genome/:id/key-envelope, unwraps
 *     with the local X25519 private key, decrypts each section with the DEK via
 *     parseBlob + decryptSection from _genome-crypto.ts.
 *   - Personal genome (no .cloud-id): legacy /genome/personal/find path.
 *     Sections may be plaintext or encrypted with the per-user symmetric key
 *     from /user/genome-key.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { createHash, createDecipheriv } from "crypto";

import { parseBlob, decryptSection as decryptSectionBlob } from "../servers/_genome-crypto";
import { loadKeypair, unwrapDek } from "../servers/_genome-crypto-v2";

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
  // Backend returns snake_case `content_encrypted`; accept both for safety.
  content_encrypted?: number;
  contentEncrypted?: number;
}

interface GenomePullResponse {
  sections: GenomeSection[];
  // Backend returns `serverSeqNum` (not `serverSeq`) at the top level.
  serverSeqNum?: number;
  serverSeq?: number;
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
 * Used only on the personal-genome path.
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
  apiUrl: string = API_URL,
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
    const res = await doFetch(`${apiUrl}/user/genome-key`, {
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
  /** Override the API base URL (default: ASHLR_API_URL env or https://api.ashlr.ai). */
  apiUrl?: string;
}): Promise<void> {
  try {
    // Kill switch
    if (process.env["ASHLR_CLOUD_GENOME_DISABLE"] === "1") return;

    const home = opts?.home ?? homedir();
    const cwd = opts?.cwd ?? process.cwd();
    const doFetch: FetchFn = opts?.fetchFn ?? fetch;
    const doSpawn = opts?.spawnFn ?? spawnSync;
    // Allow tests (and future CLI callers) to override the endpoint.
    const apiUrl = opts?.apiUrl ?? API_URL;

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

    // ---------------------------------------------------------------------------
    // Branch: team genome vs personal genome
    // ---------------------------------------------------------------------------
    // Team genome: .ashlrcode/genome/.cloud-id present in the working tree.
    // Use v2 X25519 envelope path to unwrap the DEK, then decrypt sections.
    // Personal genome: legacy /genome/personal/find + /user/genome-key path.

    const cloudIdPath = join(cwd, ".ashlrcode", "genome", ".cloud-id");
    const isTeamGenome = existsSync(cloudIdPath);

    if (isTeamGenome) {
      await runTeamGenomePull({
        cloudIdPath,
        genomeDir,
        canonUrl,
        token,
        home,
        doFetch,
        apiUrl,
      });
    } else {
      await runPersonalGenomePull({
        genomeDir,
        canonUrl,
        token,
        home,
        doFetch,
        apiUrl,
      });
    }
  } catch (err) {
    // Never propagate — session-start must always succeed.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ashlr] cloud genome pull failed: ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// Team genome pull — v2 X25519 envelope path
// ---------------------------------------------------------------------------

interface TeamPullOpts {
  cloudIdPath: string;
  genomeDir:   string;
  canonUrl:    string;
  token:       string;
  home:        string;
  doFetch:     FetchFn;
  apiUrl:      string;
}

async function runTeamGenomePull(opts: TeamPullOpts): Promise<void> {
  const { cloudIdPath, genomeDir, canonUrl, token, home, doFetch, apiUrl } = opts;

  // Read the genomeId from .cloud-id
  let genomeId: string;
  try {
    genomeId = readFileSync(cloudIdPath, "utf-8").trim();
  } catch {
    return; // unreadable .cloud-id → silent exit
  }
  if (!genomeId) return;

  // Identify ourselves so we can load the right local keypair.
  // GET /user/me → { userId }
  let userId: string;
  try {
    const meRes = await doFetch(`${apiUrl}/user/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) {
      process.stderr.write("[ashlr] team genome pull: could not identify caller — skipping\n");
      return;
    }
    const meBody = (await meRes.json()) as { userId?: string };
    if (!meBody.userId) return;
    userId = meBody.userId;
  } catch {
    return; // network error → silent exit
  }

  // Load local X25519 keypair.
  const keypair = loadKeypair(userId);
  if (!keypair) {
    process.stderr.write(
      "[ashlr] team genome pull: no local member keypair — run /ashlr-genome-keygen first\n",
    );
    return;
  }

  // Fetch wrapped DEK for this member from GET /genome/:id/key-envelope.
  let wrappedDek: string;
  try {
    const envRes = await doFetch(`${apiUrl}/genome/${genomeId}/key-envelope`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (envRes.status === 404) {
      process.stderr.write(
        "[ashlr] team genome pull: no key envelope for you — ask an admin to /ashlr-genome-rewrap\n",
      );
      return;
    }
    if (envRes.status === 403) {
      process.stderr.write(
        "[ashlr] team genome pull: your key envelope has been revoked — contact a team admin\n",
      );
      return;
    }
    if (!envRes.ok) {
      process.stderr.write(
        `[ashlr] team genome pull: envelope fetch failed (HTTP ${envRes.status})\n`,
      );
      return;
    }
    const envBody = (await envRes.json()) as { wrappedDek?: string; alg?: string };
    if (!envBody.wrappedDek) return;
    wrappedDek = envBody.wrappedDek;
  } catch {
    return; // network error → silent exit
  }

  // Unwrap the DEK with our local X25519 private key.
  let dek: Buffer;
  try {
    dek = unwrapDek(wrappedDek, keypair.privateKey);
  } catch (e) {
    process.stderr.write(
      `[ashlr] team genome pull: DEK unwrap failed — wrong key? (${(e as Error).message})\n`,
    );
    return;
  }

  // Pull sections since seq=0 (full pull; incremental pull is a future opt).
  let pullRes: Response;
  try {
    pullRes = await doFetch(`${apiUrl}/genome/${genomeId}/pull?since=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return; // network error → silent exit
  }
  if (!pullRes.ok) return;

  const pullData = (await pullRes.json()) as GenomePullResponse;
  const { sections } = pullData;
  const serverSeq = pullData.serverSeqNum ?? pullData.serverSeq ?? 0;

  mkdirSync(genomeDir, { recursive: true });

  for (const section of sections) {
    let content: string;
    const isEncrypted = (section.content_encrypted ?? section.contentEncrypted) === 1;
    if (isEncrypted) {
      // Push side serializes via serializeBlob(encryptSection(...)) → base64url
      // with a version byte prefix. parseBlob + decryptSectionBlob is the
      // correct counterpart (NOT the legacy nonce|tag|ct base64 personal path).
      try {
        const blob = parseBlob(section.content);
        content = decryptSectionBlob(blob, dek);
      } catch {
        process.stderr.write(
          `[ashlr] team genome pull: failed to decrypt section ${section.path} — skipping\n`,
        );
        continue;
      }
    } else {
      content = section.content;
    }

    const sectionPath = join(genomeDir, section.path);
    const sectionDir = dirname(sectionPath);
    if (sectionDir && sectionDir !== genomeDir) {
      mkdirSync(sectionDir, { recursive: true });
    }
    writeFileSync(sectionPath, content, "utf-8");
  }

  // Write marker file.
  const marker: CloudGenomeMarker = {
    repoUrl:  canonUrl,
    genomeId,
    builtAt:  new Date().toISOString(), // team genomes don't have a single builtAt
    pulledAt: new Date().toISOString(),
    serverSeq,
  };
  writeFileSync(join(genomeDir, ".ashlr-cloud-genome"), JSON.stringify(marker, null, 2), "utf-8");

  emitEvent(
    { event: "cloud_genome_pulled", genomeId, sections: sections.length },
    join(home, ".ashlr"),
  );
}

// ---------------------------------------------------------------------------
// Personal genome pull — legacy symmetric key path
// ---------------------------------------------------------------------------

interface PersonalPullOpts {
  genomeDir: string;
  canonUrl:  string;
  token:     string;
  home:      string;
  doFetch:   FetchFn;
  apiUrl:    string;
}

async function runPersonalGenomePull(opts: PersonalPullOpts): Promise<void> {
  const { genomeDir, canonUrl, token, home, doFetch, apiUrl } = opts;

  // Find genome by repo URL
  let findRes: Response;
  try {
    findRes = await doFetch(
      `${apiUrl}/genome/personal/find?repo_url=${encodeURIComponent(canonUrl)}`,
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
      `${apiUrl}/genome/${genomeId}/pull?since=0`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    return; // network error → silent exit
  }
  if (!pullRes.ok) return;

  const pullData = (await pullRes.json()) as GenomePullResponse;
  const { sections } = pullData;
  // Normalize: backend emits `serverSeqNum`; tolerate both spellings.
  const serverSeq = pullData.serverSeqNum ?? pullData.serverSeq ?? 0;

  // Write sections to disk
  mkdirSync(genomeDir, { recursive: true });

  // Fetch per-user key lazily — only if any section is encrypted.
  // Normalize: backend emits `content_encrypted` (snake_case); tolerate both spellings.
  const hasEncrypted = sections.some((s) => (s.content_encrypted ?? s.contentEncrypted) === 1);
  let userKey: Buffer | null = null;
  if (hasEncrypted) {
    userKey = await fetchAndCacheGenomeKey(token, home, doFetch, apiUrl);
    if (!userKey) {
      process.stderr.write(
        "[ashlr] could not fetch genome decryption key — skipping encrypted sections\n",
      );
    }
  }

  for (const section of sections) {
    let content: string;
    if ((section.content_encrypted ?? section.contentEncrypted) === 1) {
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
}

// ---------------------------------------------------------------------------
// Script entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await runCloudPull();
  process.exit(0);
}

// Silence unused-import warning — readProToken / getGitRemote kept for
// script-mode callers that may invoke them directly.
void readProToken;
void getGitRemote;
