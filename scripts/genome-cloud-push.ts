#!/usr/bin/env bun
/**
 * genome-cloud-push.ts — client-side push of the local genome to the team cloud.
 *
 * Mirrors the "fire-and-forget, swallow errors, never throw" posture of
 * scripts/genome-cloud-pull.ts. Called from SessionEnd after the scribe
 * consolidator has stabilized the local tree, or on demand via
 * /ashlr-genome-push.
 *
 * Flow:
 *   1. Read .ashlrcode/genome/.cloud-id (from /ashlr-genome-team-init); if
 *      absent, exit 0 — push is only for teams that opted in.
 *   2. Acquire a cross-process lock at .ashlrcode/genome/.push.lock (O_EXCL
 *      open). Release on exit.
 *   3. GET /genome/:id/key-envelope → wrapped DEK for this user.
 *   4. unwrapDek() with local X25519 private key → 32-byte DEK.
 *   5. Enumerate .ashlrcode/genome/{knowledge,vision,milestones,strategies}/
 *      and the top-level manifest.json. Encrypt each with the DEK via
 *      _genome-crypto.encryptSection → serializeBlob.
 *   6. Bump the local vclock (~/.ashlr/genome-vclock/<id>.json) by 1, key
 *      it off our clientId (machine-scoped, persisted at
 *      ~/.ashlr/client-id).
 *   7. POST /genome/:id/push with { sections: [{path, content, vclock}],
 *      clientId, manifest? }.
 *
 * Kill switches:
 *   ASHLR_CLOUD_GENOME_DISABLE=1 — skip everything
 *   ASHLR_PULSE_OTLP_ENDPOINT is unrelated to this path; don't conflate.
 *
 * Exits:
 *   0 success or no-op (no .cloud-id, killed, etc.)
 *   1 lockfile held (another push in progress); caller can retry later
 *   2 auth / network / server error (best-effort: also 0 when called from
 *     a hook, by passing --quiet; the exit is relevant to humans running
 *     the CLI directly)
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
  openSync,
  closeSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, relative } from "path";
import { randomBytes } from "crypto";

import {
  encryptSection,
  serializeBlob,
} from "../servers/_genome-crypto";
import { loadKeypair, unwrapDek } from "../servers/_genome-crypto-v2";

const DEFAULT_API = process.env.ASHLR_API_URL ?? "https://api.ashlr.ai";

function home(): string { return process.env.HOME ?? homedir(); }
function ashlrDir(): string { return join(home(), ".ashlr"); }
function proTokenPath(): string { return join(ashlrDir(), "pro-token"); }
function clientIdPath(): string { return join(ashlrDir(), "client-id"); }
function vclockPath(genomeId: string): string {
  return join(ashlrDir(), "genome-vclock", `${genomeId}.json`);
}

function err(m: string): void { process.stderr.write(m + "\n"); }
function out(m: string): void { process.stdout.write(m + "\n"); }

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  quiet: boolean;
  dryRun: boolean;
  endpoint: string;
  cwd: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    quiet: false,
    dryRun: false,
    endpoint: DEFAULT_API,
    cwd: process.cwd(),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--endpoint") out.endpoint = argv[++i] ?? out.endpoint;
    else if (a === "--cwd") out.cwd = argv[++i] ?? out.cwd;
  }
  return out;
}

// ---------------------------------------------------------------------------
// .cloud-id — caches the genomeId per-repo so we don't have to resolve via
// remote.origin.url every push.
// ---------------------------------------------------------------------------

function readCloudId(cwd: string): string | null {
  const path = join(cwd, ".ashlrcode", "genome", ".cloud-id");
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8").trim();
  return content || null;
}

// ---------------------------------------------------------------------------
// client-id — stable per-machine identifier used as the vclock component.
// ---------------------------------------------------------------------------

function readOrCreateClientId(): string {
  const path = clientIdPath();
  if (existsSync(path)) {
    const id = readFileSync(path, "utf-8").trim();
    if (id) return id;
  }
  mkdirSync(dirname(path), { recursive: true });
  const id = `c-${randomBytes(6).toString("hex")}`;
  writeFileSync(path, id + "\n", { encoding: "utf-8", mode: 0o600 });
  return id;
}

// ---------------------------------------------------------------------------
// vclock — one map per genomeId. Bump clientId's counter on each push.
// ---------------------------------------------------------------------------

type VClock = Record<string, number>;

function loadVClock(genomeId: string): VClock {
  const path = vclockPath(genomeId);
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf-8")) as VClock; } catch { return {}; }
}

function saveVClock(genomeId: string, vc: VClock): void {
  const path = vclockPath(genomeId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(vc), { encoding: "utf-8", mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Lockfile (cross-process)
// ---------------------------------------------------------------------------

function lockPath(cwd: string): string {
  return join(cwd, ".ashlrcode", "genome", ".push.lock");
}

/**
 * Acquire an exclusive lock. Returns the fd on success, or null if another
 * process already holds it.
 */
function acquireLock(cwd: string): number | null {
  const p = lockPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  try {
    const fd = openSync(p, "wx"); // O_WRONLY | O_CREAT | O_EXCL
    return fd;
  } catch {
    return null;
  }
}

function releaseLock(cwd: string, fd: number): void {
  try { closeSync(fd); } catch { /* ok */ }
  try { rmSync(lockPath(cwd), { force: true }); } catch { /* ok */ }
}

// ---------------------------------------------------------------------------
// Genome enumeration — the REAL layout (not sections/*).
// ---------------------------------------------------------------------------

const SECTION_DIRS = ["knowledge", "vision", "milestones", "strategies"];

interface SectionFile {
  path:    string;  // relative to .ashlrcode/genome/, e.g. "knowledge/decisions.md"
  content: string;  // plaintext
}

function enumerateSections(cwd: string): SectionFile[] {
  const root = join(cwd, ".ashlrcode", "genome");
  if (!existsSync(root)) return [];
  const out: SectionFile[] = [];

  for (const dir of SECTION_DIRS) {
    const dirPath = join(root, dir);
    if (!existsSync(dirPath)) continue;
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!e.name.endsWith(".md")) continue;
        const full = join(dirPath, e.name);
        try {
          const content = readFileSync(full, "utf-8");
          // Section paths are sent to the cloud API and consumed by the
          // pull side with `join()`, so they MUST be POSIX. Normalize here
          // so Windows-native backslashes never leak into the protocol.
          const rel = relative(root, full).replace(/\\/g, "/");
          out.push({ path: rel, content });
        } catch { /* unreadable, skip */ }
      }
    } catch { /* unreadable dir, skip */ }
  }

  // manifest.json at top level — also sync it.
  const manifestPath = join(root, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const content = readFileSync(manifestPath, "utf-8");
      out.push({ path: "manifest.json", content });
    } catch { /* skip */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function api<T>(
  method: string,
  url: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: T | null; text: string }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let j: T | null = null;
  try { j = text ? (JSON.parse(text) as T) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: j, text };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    err("Usage: /ashlr-genome-push [--quiet] [--dry-run] [--endpoint <url>] [--cwd <dir>]");
    return 0;
  }

  if (process.env.ASHLR_CLOUD_GENOME_DISABLE === "1") return 0;

  const genomeId = readCloudId(args.cwd);
  if (!genomeId) {
    if (!args.quiet) err("No .cloud-id in this repo. Run /ashlr-genome-team-init first.");
    return 0;
  }

  if (!existsSync(proTokenPath())) {
    if (!args.quiet) err("No Ashlr Pro token. Run /ashlr-upgrade first.");
    return 0;
  }
  const token = readFileSync(proTokenPath(), "utf-8").trim();
  if (!token) return 0;

  // Identify caller. userId from /user/me so we know which member-keys file to load.
  const me = await api<{ userId: string }>("GET", `${args.endpoint}/user/me`, token);
  if (me.status !== 200 || !me.body) {
    if (!args.quiet) err(`Couldn't identify caller (HTTP ${me.status}).`);
    return 2;
  }
  const userId = me.body.userId;

  const keypair = loadKeypair(userId);
  if (!keypair) {
    if (!args.quiet) err("No local member keypair. Run /ashlr-genome-keygen first.");
    return 2;
  }

  // Acquire lock early so concurrent pushes serialize cleanly.
  const lockFd = acquireLock(args.cwd);
  if (lockFd === null) {
    if (!args.quiet) err("Another push is already in progress for this repo. Try again in a moment.");
    return 1;
  }

  try {
    // Fetch and unwrap the team DEK for this user.
    const env = await api<{ wrappedDek: string; alg: string }>(
      "GET", `${args.endpoint}/genome/${genomeId}/key-envelope`, token,
    );
    if (env.status !== 200 || !env.body) {
      if (env.status === 404) {
        if (!args.quiet) err("No key envelope on file for you — ask an admin to /ashlr-genome-rewrap for you.");
      } else if (!args.quiet) err(`Envelope fetch failed: HTTP ${env.status}`);
      return 2;
    }
    let dek: Buffer;
    try {
      dek = unwrapDek(env.body.wrappedDek, keypair.privateKey);
    } catch (e) {
      if (!args.quiet) err(`Couldn't unwrap the team DEK — wrong key? (${(e as Error).message})`);
      return 2;
    }

    // Enumerate + encrypt sections.
    const sections = enumerateSections(args.cwd);
    if (sections.length === 0) {
      if (!args.quiet) err("No genome sections to push (empty .ashlrcode/genome/).");
      return 0;
    }

    // Bump vclock for our client id.
    const clientId = readOrCreateClientId();
    const vclock = loadVClock(genomeId);
    vclock[clientId] = (vclock[clientId] ?? 0) + 1;

    const payloadSections = sections.map((s) => ({
      path:    s.path,
      content: serializeBlob(encryptSection(s.content, dek)),
      vclock:  { ...vclock },
    }));

    if (args.dryRun) {
      if (!args.quiet) err(`--dry-run: would POST ${payloadSections.length} section(s).`);
      for (const s of payloadSections) err(`  ${s.path}`);
      return 0;
    }

    const push = await api<{ serverSeqNum?: number; error?: string }>(
      "POST", `${args.endpoint}/genome/${genomeId}/push`, token,
      { sections: payloadSections, clientId },
    );
    if (push.status !== 200) {
      if (!args.quiet) err(`Push failed: HTTP ${push.status}${push.body?.error ? ` — ${push.body.error}` : ""}`);
      return 2;
    }

    // Persist the new vclock only after a successful push so a mid-push
    // crash doesn't leave us with a ghost-bumped vclock.
    saveVClock(genomeId, vclock);

    if (!args.quiet) {
      out(`Pushed ${payloadSections.length} section(s) to ${genomeId}.`);
      if (push.body?.serverSeqNum !== undefined) out(`  serverSeq: ${push.body.serverSeqNum}`);
    }
    return 0;
  } finally {
    releaseLock(args.cwd, lockFd);
  }
}

// ---------------------------------------------------------------------------
// Test hooks — exported for unit tests.
// ---------------------------------------------------------------------------

export const __internals = {
  acquireLock,
  releaseLock,
  enumerateSections,
  loadVClock,
  saveVClock,
  readOrCreateClientId,
  readCloudId,
};

if (import.meta.main) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => { err(`fatal: ${(e as Error).message}`); process.exit(2); });
}

// Silence unused-import TS warning for types-only imports elsewhere in the module.
void statSync;
