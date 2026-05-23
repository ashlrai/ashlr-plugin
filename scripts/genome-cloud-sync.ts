#!/usr/bin/env bun
/**
 * genome-cloud-sync — Q2 plugin-side cloud delta sync.
 *
 * Polls GET /genome/cloud-deltas?genome_id=X&since_cursor=N from the Pro
 * backend and writes each returned delta into the local genome:
 *
 *   commit         → .ashlrcode/genome/sections/commits/<sha>.json
 *   pr_merged      → .ashlrcode/genome/sections/prs/<number>.json    (Q3)
 *   issue_closed   → .ashlrcode/genome/sections/issues/<number>.json (Q3)
 *
 * Q3 update: PR / issue deltas now write into dedicated retrieval-friendly
 * subdirs (prs/ + issues/) with structured PrSection / IssueSection payloads
 * instead of envelope-wrapped raw deltas in cloud/. The retrievers in
 * _genome-prs.ts + _genome-issues.ts consume those files directly. Older
 * envelope files in cloud/ are left untouched for forward-compat with users
 * mid-upgrade — retrieval only looks at prs/ + issues/.
 *
 * Cursor state lives at `.ashlrcode/genome/_cloud-cursor.json` and is only
 * advanced on a fully successful pull. Network failures leave the cursor
 * untouched so the next session retries.
 *
 * Tier gate (HARDCODED — first line of syncCloudDeltas):
 *   free       → returns { skipped: true, reason: "free-tier" } immediately
 *   pro / team → proceeds
 *
 * Best-effort budget: SessionStart calls this with a 2s hard ceiling. The
 * caller (hooks/session-start.ts) is responsible for the timeout; this
 * function itself just tries the network and writes whatever it can.
 *
 * CLI:
 *   bun scripts/genome-cloud-sync.ts             # actually sync
 *   bun scripts/genome-cloud-sync.ts --dry-run   # print plan, write nothing
 *   bun scripts/genome-cloud-sync.ts --limit=50  # cap per-request page size
 *
 * Privacy: cloud sections store only what the server returned — title,
 * message, file paths, optional 2-3 sentence summary. No diff content.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL_DEFAULT = process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";

/** Hard cap on cloud sections kept on disk (across all kinds). */
export const CLOUD_RETENTION_LIMIT = 200;

/** Default per-request page size when --limit isn't supplied. */
export const DEFAULT_LIMIT = 100;

/** Subdirectory under .ashlrcode/genome/sections/ for non-commit cloud entries. */
export const CLOUD_SUBDIR = "cloud";

/** Subdirectory for commit deltas — shared with the local commit watcher. */
export const COMMITS_SUBDIR = "commits";

/** Q3 — dedicated subdir for `pr_merged` deltas, consumed by _genome-prs.ts. */
export const PRS_SUBDIR = "prs";

/** Q3 — dedicated subdir for `issue_closed` deltas, consumed by _genome-issues.ts. */
export const ISSUES_SUBDIR = "issues";

/** Q3 — per-subdir cap (independent of CLOUD_RETENTION_LIMIT). */
export const PR_RETENTION_LIMIT = 100;
export const ISSUE_RETENTION_LIMIT = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = "free" | "pro" | "team";

export type DeltaKind = "commit" | "pr_merged" | "issue_closed";

export interface CloudDelta {
  id: number;
  cursor: number;
  kind: DeltaKind;
  sourceSha: string;
  recordedAt: string;
  payload: unknown;
}

export interface CloudDeltasResponse {
  deltas: CloudDelta[];
  nextCursor: number;
}

export interface CloudCursorFile {
  genomeId: string | null;
  cursor: number;
  lastSyncedAt: string;
}

export interface SyncResult {
  skipped?: true;
  reason?: string;
  written?: number;
  cursorBefore?: number;
  cursorAfter?: number;
  pruned?: number;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function genomeRoot(cwd: string): string {
  return join(cwd, ".ashlrcode", "genome");
}

export function sectionsRoot(cwd: string): string {
  return join(genomeRoot(cwd), "sections");
}

export function commitsDir(cwd: string): string {
  return join(sectionsRoot(cwd), COMMITS_SUBDIR);
}

export function cloudDir(cwd: string): string {
  return join(sectionsRoot(cwd), CLOUD_SUBDIR);
}

export function prsDir(cwd: string): string {
  return join(sectionsRoot(cwd), PRS_SUBDIR);
}

export function issuesDir(cwd: string): string {
  return join(sectionsRoot(cwd), ISSUES_SUBDIR);
}

export function cursorPath(cwd: string): string {
  return join(genomeRoot(cwd), "_cloud-cursor.json");
}

// ---------------------------------------------------------------------------
// Cursor I/O
// ---------------------------------------------------------------------------

export function readCursor(cwd: string): CloudCursorFile | null {
  const p = cursorPath(cwd);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CloudCursorFile;
  } catch {
    return null;
  }
}

export function writeCursor(cwd: string, c: CloudCursorFile): void {
  const p = cursorPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Pro token + genome-id discovery
// ---------------------------------------------------------------------------

function readProToken(home: string): string {
  try {
    return readFileSync(join(home, ".ashlr", "pro-token"), "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Discover the cloud genome id for the current repo. Reads the marker file
 * written by genome-cloud-pull (`~/.ashlr/genomes/<hash>/.ashlr-cloud-genome`).
 *
 * Returns null when no marker exists — meaning the user hasn't yet completed
 * a full cloud-pull for this repo, so there's no genome to sync deltas for.
 */
export function findGenomeIdForCwd(home: string, cwd: string): string | null {
  try {
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const res = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd,
      timeout: 2000,
      encoding: "utf-8",
    });
    if (res.status !== 0 || !res.stdout) return null;
    const remote = (res.stdout as string).trim();
    // Canonicalize: lowercase, strip .git, ssh→https. Match server-side rules.
    let url = remote;
    const ssh = url.match(/^git@([^:]+):(.+)$/);
    if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
    url = url.toLowerCase().replace(/\/+$/, "");
    if (url.endsWith(".git")) url = url.slice(0, -4);
    url = url.replace(/\/+$/, "");

    const { createHash } = require("crypto") as typeof import("crypto");
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
    const marker = join(home, ".ashlr", "genomes", hash, ".ashlr-cloud-genome");
    if (!existsSync(marker)) return null;
    const parsed = JSON.parse(readFileSync(marker, "utf-8")) as { genomeId?: string };
    return parsed.genomeId ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Section writers (one per delta kind)
// ---------------------------------------------------------------------------

function writeCommitSection(cwd: string, delta: CloudDelta): string {
  const dir = commitsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${delta.sourceSha}.json`);
  writeFileSync(p, JSON.stringify(delta.payload, null, 2), "utf-8");
  return p;
}

/**
 * Best-effort GitHub URL builder. The webhook payload doesn't include the
 * canonical URL, so we reconstruct from the cwd's git remote (origin). When
 * we can't read it we still write the section — just with an empty url string.
 */
function buildGithubUrl(cwd: string, kind: "pull" | "issues", num: number | string): string {
  try {
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const res = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd,
      timeout: 2000,
      encoding: "utf-8",
    });
    if (res.status !== 0 || !res.stdout) return "";
    let url = (res.stdout as string).trim();
    const ssh = url.match(/^git@([^:]+):(.+)$/);
    if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
    if (url.endsWith(".git")) url = url.slice(0, -4);
    url = url.replace(/\/+$/, "");
    return `${url}/${kind}/${num}`;
  } catch {
    return "";
  }
}

interface PrPayloadShape {
  kind?: string;
  number?: number;
  title?: string;
  mergedSha?: string;
  author?: string;
  mergedAt?: string;
  filesChanged?: string[];
  summary?: string;
}

interface IssuePayloadShape {
  kind?: string;
  number?: number;
  title?: string;
  closedAt?: string;
  author?: string;
  labels?: string[];
  summary?: string;
}

/**
 * Q3: write a structured PR section to sections/prs/<number>.json.
 * Schema matches PrSection in _manifest-v2.ts so retrieval can read it back.
 */
function writePrSection(cwd: string, delta: CloudDelta): string {
  const dir = prsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const p = (delta.payload ?? {}) as PrPayloadShape;
  const number = p.number ?? Number(delta.sourceSha) ?? 0;
  const id = String(number);
  const section = {
    id,
    title: (p.title ?? "").slice(0, 512),
    mergedAt: p.mergedAt ?? "",
    author: p.author ?? "",
    filesChanged: Array.isArray(p.filesChanged) ? p.filesChanged : [],
    summary: (p.summary ?? "").slice(0, 1024),
    url: buildGithubUrl(cwd, "pull", number),
  };
  const out = join(dir, `${id}.json`);
  writeFileSync(out, JSON.stringify(section, null, 2), "utf-8");
  return out;
}

/**
 * Q3: write a structured Issue section to sections/issues/<number>.json.
 * Schema matches IssueSection in _manifest-v2.ts.
 */
function writeIssueSection(cwd: string, delta: CloudDelta): string {
  const dir = issuesDir(cwd);
  mkdirSync(dir, { recursive: true });
  const p = (delta.payload ?? {}) as IssuePayloadShape;
  const number = p.number ?? Number(delta.sourceSha) ?? 0;
  const id = String(number);
  const section = {
    id,
    title: (p.title ?? "").slice(0, 512),
    closedAt: p.closedAt ?? "",
    author: p.author ?? "",
    labels: Array.isArray(p.labels) ? p.labels : [],
    summary: (p.summary ?? "").slice(0, 1024),
    url: buildGithubUrl(cwd, "issues", number),
  };
  const out = join(dir, `${id}.json`);
  writeFileSync(out, JSON.stringify(section, null, 2), "utf-8");
  return out;
}

function applyDelta(cwd: string, delta: CloudDelta): string | null {
  if (delta.kind === "commit") return writeCommitSection(cwd, delta);
  if (delta.kind === "pr_merged") return writePrSection(cwd, delta);
  if (delta.kind === "issue_closed") return writeIssueSection(cwd, delta);
  return null;
}

// ---------------------------------------------------------------------------
// Pruner — keep last CLOUD_RETENTION_LIMIT total cloud sections by mtime
// ---------------------------------------------------------------------------

export function pruneCloudSections(cwd: string, limit = CLOUD_RETENTION_LIMIT): number {
  const dirs = [commitsDir(cwd), cloudDir(cwd)];
  type Entry = { path: string; mtimeMs: number };
  const all: Entry[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".json")) continue;
      const p = join(d, name);
      try {
        const st = statSync(p);
        all.push({ path: p, mtimeMs: st.mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  if (all.length <= limit) return 0;
  all.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const toDrop = all.slice(limit);
  let dropped = 0;
  for (const ent of toDrop) {
    try {
      unlinkSync(ent.path);
      dropped++;
    } catch {
      // ignore
    }
  }
  return dropped;
}

/**
 * Q3: prune a single retrieval subdir (prs/ or issues/) to the last `limit`
 * files by mtime. Independent of the aggregate CLOUD_RETENTION_LIMIT —
 * PR + issue retrieval expects a deeper history (100 each) so users can
 * still find "auth bug" from 3 weeks ago.
 *
 * Returns number of files dropped. No-op when the dir doesn't exist or
 * holds fewer files than `limit`.
 */
export function pruneSubdir(cwd: string, subdir: string, limit: number): number {
  const dir = join(sectionsRoot(cwd), subdir);
  if (!existsSync(dir)) return 0;
  type Entry = { path: string; mtimeMs: number };
  const all: Entry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      all.push({ path: p, mtimeMs: st.mtimeMs });
    } catch {
      // ignore
    }
  }
  if (all.length <= limit) return 0;
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toDrop = all.slice(limit);
  let dropped = 0;
  for (const ent of toDrop) {
    try {
      unlinkSync(ent.path);
      dropped++;
    } catch {
      // ignore
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

export interface SyncOpts {
  tier: Tier;
  /** Override for tests / CLI --dry-run. */
  dryRun?: boolean;
  /** Per-request page size (server caps at 500). */
  limit?: number;
  /** Override cwd (default process.cwd()). */
  cwd?: string;
  /** Override $HOME (default homedir()). */
  home?: string;
  /** Override fetch (tests inject a mock). */
  fetchFn?: FetchFn;
  /** Override API base URL. */
  apiUrl?: string;
  /** Explicit genome id (skips marker-file discovery). */
  genomeId?: string;
  /** Explicit pro-token (skips file read). */
  proToken?: string;
}

export async function syncCloudDeltas(opts: SyncOpts): Promise<SyncResult> {
  // ---- Tier gate — FIRST line of real work. ----
  if (opts.tier === "free") {
    return { skipped: true, reason: "free-tier" };
  }

  // Kill switch — same flag the rest of the cloud pipeline honors.
  if (process.env["ASHLR_CLOUD_GENOME_DISABLE"] === "1") {
    return { skipped: true, reason: "kill-switch" };
  }

  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const doFetch: FetchFn = opts.fetchFn ?? fetch;
  const apiUrl = opts.apiUrl ?? API_URL_DEFAULT;
  const limit = Math.max(1, Math.min(500, opts.limit ?? DEFAULT_LIMIT));

  // No genome → nothing to sync. This is the steady state for users who
  // haven't initialised a local genome yet, so it must be a quiet no-op.
  if (!existsSync(genomeRoot(cwd))) {
    return { skipped: true, reason: "no-local-genome" };
  }

  const proToken = opts.proToken ?? readProToken(home);
  if (!proToken) return { skipped: true, reason: "no-pro-token" };

  const genomeId = opts.genomeId ?? findGenomeIdForCwd(home, cwd);
  if (!genomeId) return { skipped: true, reason: "no-cloud-genome" };

  const cursorFile = readCursor(cwd);
  const cursorBefore =
    cursorFile && cursorFile.genomeId === genomeId ? cursorFile.cursor : 0;

  // ---- Network ----
  let res: Response;
  try {
    res = await doFetch(
      `${apiUrl}/genome/cloud-deltas?genome_id=${encodeURIComponent(genomeId)}&since_cursor=${cursorBefore}&limit=${limit}`,
      {
        headers: {
          Authorization: `Bearer ${proToken}`,
          Accept: "application/json",
        },
      },
    );
  } catch {
    // Network failure: leave the cursor untouched. Next session retries.
    return { skipped: true, reason: "network-error", cursorBefore };
  }
  if (!res.ok) {
    return {
      skipped: true,
      reason: `http-${res.status}`,
      cursorBefore,
    };
  }

  let body: CloudDeltasResponse;
  try {
    body = (await res.json()) as CloudDeltasResponse;
  } catch {
    return { skipped: true, reason: "bad-json", cursorBefore };
  }

  if (!Array.isArray(body.deltas) || body.deltas.length === 0) {
    // Empty page — still advance cursor if server bumped nextCursor.
    const nextCursor = Number.isFinite(body.nextCursor) ? body.nextCursor : cursorBefore;
    if (!opts.dryRun && nextCursor > cursorBefore) {
      writeCursor(cwd, {
        genomeId,
        cursor: nextCursor,
        lastSyncedAt: new Date().toISOString(),
      });
    }
    return { written: 0, cursorBefore, cursorAfter: nextCursor, pruned: 0 };
  }

  // ---- Apply ----
  let written = 0;
  if (!opts.dryRun) {
    for (const delta of body.deltas) {
      try {
        if (applyDelta(cwd, delta)) written++;
      } catch {
        // Individual section write failure shouldn't tank the batch.
      }
    }
  } else {
    written = body.deltas.length; // dry-run reports "would-write" count
  }

  // Cursor advance — use the server's nextCursor, falling back to the last
  // applied delta's cursor.
  const lastCursor = body.deltas[body.deltas.length - 1]!.cursor;
  const cursorAfter = Number.isFinite(body.nextCursor)
    ? Math.max(body.nextCursor, lastCursor)
    : lastCursor;

  let pruned = 0;
  if (!opts.dryRun) {
    writeCursor(cwd, {
      genomeId,
      cursor: cursorAfter,
      lastSyncedAt: new Date().toISOString(),
    });
    pruned = pruneCloudSections(cwd);
    // Q3: keep the per-subdir caps independent from the aggregate so PR +
    // issue history remains deep enough to be useful for retrieval.
    pruned += pruneSubdir(cwd, PRS_SUBDIR, PR_RETENTION_LIMIT);
    pruned += pruneSubdir(cwd, ISSUES_SUBDIR, ISSUE_RETENTION_LIMIT);
  }

  return { written, cursorBefore, cursorAfter, pruned };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv: string[]): { dryRun: boolean; limit?: number } {
  let dryRun = false;
  let limit: number | undefined;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--limit=")) {
      const n = Number.parseInt(a.slice("--limit=".length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { dryRun, limit };
}

async function detectTier(): Promise<Tier> {
  // Mirror scripts/check-tier.ts but inline so this script has zero relative
  // imports (it can run from anywhere and be vendored into the hook tree).
  try {
    const cachePath = join(homedir(), ".ashlr", "pro-token-cache.json");
    if (!existsSync(cachePath)) return "free";
    const c = JSON.parse(readFileSync(cachePath, "utf-8")) as {
      valid?: boolean;
      validatedAt?: string;
      plan?: string;
    };
    if (c.valid !== true || !c.validatedAt) return "free";
    const age = Date.now() - new Date(c.validatedAt).getTime();
    if (age >= 7 * 24 * 60 * 60 * 1000) return "free";
    if (c.plan === "team") return "team";
    if (c.plan === "pro") return "pro";
    return "free";
  } catch {
    return "free";
  }
}

if (import.meta.main) {
  const args = parseCliArgs(process.argv.slice(2));
  const tier = await detectTier();
  const result = await syncCloudDeltas({
    tier,
    dryRun: args.dryRun,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
}
