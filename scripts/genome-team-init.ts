#!/usr/bin/env bun
/**
 * genome-team-init.ts — bootstrap a team-cloud genome for the current repo.
 *
 * One-time setup, admin-only. Flow:
 *   1. Resolve the repo URL from `git remote get-url origin`.
 *   2. POST /genome/init { orgId, repoUrl } → returns { genomeId }.
 *   3. Generate a fresh 32-byte DEK.
 *   4. Load the caller's X25519 keypair (must have run /ashlr-genome-keygen).
 *   5. Wrap the DEK for the caller's own pubkey (so push immediately works).
 *   6. POST /genome/:id/key-envelope targeting self.
 *   7. Write .ashlrcode/genome/.cloud-id so subsequent pushes find the genome.
 *
 * Idempotent: if .cloud-id already exists, prints status and exits 0 unless
 * --force is supplied.
 *
 * Post-init, an admin invites teammates via /ashlr-team-invite (pre-existing).
 * Once they accept and run /ashlr-genome-keygen, the admin re-runs this with
 * --wrap-all to mint envelopes for every team member with a pubkey on file.
 *
 * Exits:
 *   0 success or idempotent no-op
 *   2 prereq missing (no pro-token, no member keypair, no team, not admin)
 *   3 network / server error
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { spawnSync } from "child_process";

import {
  ENVELOPE_ALG,
  loadKeypair,
  wrapDek,
} from "../servers/_genome-crypto-v2";

const DEFAULT_API = process.env.ASHLR_API_URL ?? "https://api.ashlr.ai";

function home(): string { return process.env.HOME ?? homedir(); }
function proTokenPath(): string { return join(home(), ".ashlr", "pro-token"); }
function cloudIdPath(cwd: string): string {
  return join(cwd, ".ashlrcode", "genome", ".cloud-id");
}

function err(m: string): void { process.stderr.write(m + "\n"); }
function out(m: string): void { process.stdout.write(m + "\n"); }

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  force: boolean;
  wrapAll: boolean;
  endpoint: string;
  cwd: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    force: false,
    wrapAll: false,
    endpoint: DEFAULT_API,
    cwd: process.cwd(),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--force") out.force = true;
    else if (a === "--wrap-all") out.wrapAll = true;
    else if (a === "--endpoint") out.endpoint = argv[++i] ?? out.endpoint;
    else if (a === "--cwd") out.cwd = argv[++i] ?? out.cwd;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git remote
// ---------------------------------------------------------------------------

function readRepoUrl(cwd: string): string | null {
  const res = spawnSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
    encoding: "utf-8",
    timeout: 1000,
  });
  if (res.status !== 0) return null;
  const url = res.stdout.trim();
  return url || null;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

interface ApiResp<T> { status: number; body: T | null; text: string }

async function api<T>(
  method: string,
  url: string,
  token: string,
  body?: unknown,
): Promise<ApiResp<T>> {
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
    err("Usage: /ashlr-genome-team-init [--force] [--wrap-all] [--endpoint <url>] [--cwd <dir>]");
    return 0;
  }

  // Prereq: pro-token.
  if (!existsSync(proTokenPath())) {
    err("No Ashlr Pro token. Run /ashlr-upgrade first.");
    return 2;
  }
  const token = readFileSync(proTokenPath(), "utf-8").trim();
  if (!token) { err("Pro token file is empty."); return 2; }

  // Prereq: identify caller, confirm team + admin role.
  const me = await api<{ userId: string; email: string }>(
    "GET", `${args.endpoint}/user/me`, token,
  );
  if (me.status !== 200 || !me.body) {
    err(`Couldn't identify caller (HTTP ${me.status}).`);
    return 3;
  }
  const userId = me.body.userId;

  // Prereq: local X25519 keypair.
  const kp = loadKeypair(userId);
  if (!kp) {
    err("No local member keypair. Run /ashlr-genome-keygen first.");
    return 2;
  }

  // Branch: --wrap-all? Then skip init and just mint envelopes for every
  // team member with a pubkey on file, using the existing DEK. (Requires
  // .cloud-id already present.)
  if (args.wrapAll) {
    return wrapAllFlow(args, token, userId, kp.privateKey);
  }

  // Standard init path.
  const existingCloudId = existsSync(cloudIdPath(args.cwd))
    ? readFileSync(cloudIdPath(args.cwd), "utf-8").trim()
    : null;
  if (existingCloudId && !args.force) {
    out(`Team-cloud genome already initialized for this repo.`);
    out(`  genomeId: ${existingCloudId}`);
    out(`  Re-run with --force to reinitialize (rotates the DEK), or`);
    out(`  --wrap-all to mint envelopes for teammates who've run /ashlr-genome-keygen since.`);
    return 0;
  }

  const repoUrl = readRepoUrl(args.cwd);
  if (!repoUrl) {
    err("No git remote origin — team-cloud init needs a repo URL.");
    return 2;
  }

  // Server needs orgId — it's the caller's team.id, NOT trusted from the
  // client. Server-side enforces that. We still include it because the
  // POST /genome/init schema requires both fields. Use a placeholder; the
  // server overrides with membership.team.id.
  const initRes = await api<{ genomeId: string; cloneToken?: string }>(
    "POST", `${args.endpoint}/genome/init`, token,
    { orgId: "self", repoUrl },
  );
  if (initRes.status === 403) {
    err("Team tier required. Upgrade at /ashlr-upgrade or ask an admin.");
    return 2;
  }
  if (initRes.status !== 200 || !initRes.body?.genomeId) {
    err(`Genome init failed: HTTP ${initRes.status}`);
    return 3;
  }
  const genomeId = initRes.body.genomeId;

  // Generate DEK, wrap to self, upload.
  const dek = randomBytes(32);
  const envelope = wrapDek(dek, kp.publicKey);

  const envRes = await api<{ ok: boolean }>(
    "POST", `${args.endpoint}/genome/${genomeId}/key-envelope`, token,
    { memberUserId: userId, wrappedDek: envelope, alg: ENVELOPE_ALG },
  );
  if (envRes.status !== 200) {
    err(`Envelope upload failed: HTTP ${envRes.status}. Genome was created but isn't usable until an admin wraps a DEK for you.`);
    return 3;
  }

  // Persist .cloud-id locally so the push path can find the genome.
  const cloudIdP = cloudIdPath(args.cwd);
  mkdirSync(dirname(cloudIdP), { recursive: true });
  writeFileSync(cloudIdP, genomeId + "\n", { encoding: "utf-8" });

  out(`Team-cloud genome initialized for this repo.`);
  out(`  genomeId: ${genomeId}`);
  out(`  repoUrl:  ${repoUrl}`);
  out(`  cloud-id: ${cloudIdP}   (commit this so teammates auto-discover)`);
  out(``);
  out(`Teammates join via /ashlr-team-invite + /ashlr-genome-keygen on their machine.`);
  out(`Then run: /ashlr-genome-team-init --wrap-all   to mint envelopes for them.`);
  return 0;
}

// ---------------------------------------------------------------------------
// --wrap-all: admin mints envelopes for every team member who has uploaded a
// pubkey but doesn't yet have an envelope for this genome.
// ---------------------------------------------------------------------------

async function wrapAllFlow(
  args: Args,
  token: string,
  _userId: string,
  privateKey: string,
): Promise<number> {
  const cloudIdP = cloudIdPath(args.cwd);
  if (!existsSync(cloudIdP)) {
    err("No .cloud-id in this repo. Run /ashlr-genome-team-init (without --wrap-all) first.");
    return 2;
  }
  const genomeId = readFileSync(cloudIdP, "utf-8").trim();

  // Unwrap our own existing envelope to recover the team DEK.
  const envRes = await api<{ wrappedDek: string; alg: string }>(
    "GET", `${args.endpoint}/genome/${genomeId}/key-envelope`, token,
  );
  if (envRes.status !== 200 || !envRes.body) {
    err(`Couldn't fetch your own envelope (HTTP ${envRes.status}). Is the genome initialized?`);
    return 3;
  }
  const { unwrapDek } = await import("../servers/_genome-crypto-v2");
  let dek: Buffer;
  try { dek = unwrapDek(envRes.body.wrappedDek, privateKey); }
  catch (e) { err(`Unwrap failed: ${(e as Error).message}`); return 3; }

  // List members + pubkeys.
  interface MemberRow { userId: string; email: string; role: string; pubkey: string | null; alg: string | null }
  const members = await api<{ members: MemberRow[] }>(
    "GET", `${args.endpoint}/genome/${genomeId}/members`, token,
  );
  if (members.status !== 200 || !members.body) {
    err(`Couldn't list team members (HTTP ${members.status}).`);
    return 3;
  }

  let wrapped = 0;
  const skipped: string[] = [];
  for (const m of members.body.members) {
    if (!m.pubkey) {
      // Print the skip inline so the admin sees exactly which teammates
      // still need to run /ashlr-genome-keygen — don't bury it in a
      // single "skipped N" line at the bottom.
      out(`  skipped → ${m.email} (${m.role}) — no pubkey on file`);
      skipped.push(m.email);
      continue;
    }
    const envelope = wrapDek(dek, m.pubkey);
    const r = await api<{ ok: boolean }>(
      "POST", `${args.endpoint}/genome/${genomeId}/key-envelope`, token,
      { memberUserId: m.userId, wrappedDek: envelope, alg: ENVELOPE_ALG },
    );
    if (r.status === 200) {
      wrapped++;
      out(`  wrapped → ${m.email} (${m.role})`);
    } else {
      err(`  FAILED  → ${m.email}: HTTP ${r.status}`);
    }
  }

  out(``);
  out(`Wrapped ${wrapped} envelope(s). Skipped ${skipped.length} member(s) without a pubkey yet.`);
  if (skipped.length > 0) {
    out(`Ask these teammates to run /ashlr-genome-keygen, then re-run this command:`);
    for (const email of skipped) out(`  - ${email}`);
  }
  return 0;
}

export const __internals = { readRepoUrl, cloudIdPath };

if (import.meta.main) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => { err(`fatal: ${(e as Error).message}`); process.exit(3); });
}
