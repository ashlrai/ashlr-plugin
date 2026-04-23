#!/usr/bin/env bun
/**
 * genome-keygen.ts — generate an X25519 keypair for team-cloud-genome v2 and
 * upload the public half to the Ashlr server.
 *
 * Invoked by /ashlr-genome-keygen. Idempotent: if a keypair already exists
 * on disk and the server already has the matching pubkey, it prints "already
 * registered" and exits 0.
 *
 * Flow:
 *   1. Read ~/.ashlr/pro-token (from /ashlr-upgrade).
 *   2. GET /user/me → userId.
 *   3. Check local ~/.ashlr/member-keys/<userId>.json + server /user/genome-pubkey:
 *        - both present + same pubkey → no-op.
 *        - local absent OR server absent → regenerate + upload.
 *   4. Generate X25519 keypair.
 *   5. Save locally (mode 0600).
 *   6. POST /user/genome-pubkey with { pubkey, alg: "x25519-v1" }.
 *
 * Flags:
 *   --force          regenerate even if a keypair already exists (rotates it)
 *   --endpoint <url> override default https://api.ashlr.ai
 *   --dry-run        print what would happen; no network, no file writes
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import {
  generateKeyPair,
  loadKeypair,
  memberKeyPath,
  saveKeypair,
  type StoredKeypair,
} from "../servers/_genome-crypto-v2";

const DEFAULT_API = process.env.ASHLR_API_URL ?? "https://api.ashlr.ai";
const ALG = "x25519-v1";

function proTokenPath(): string {
  return join(process.env.HOME ?? homedir(), ".ashlr", "pro-token");
}

function readProToken(): string | null {
  const path = proTokenPath();
  if (!existsSync(path)) return null;
  const t = readFileSync(path, "utf-8").trim();
  return t || null;
}

interface Args {
  force: boolean;
  dryRun: boolean;
  endpoint: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { force: false, dryRun: false, endpoint: DEFAULT_API, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--endpoint") out.endpoint = argv[++i] ?? out.endpoint;
  }
  return out;
}

function err(m: string): void { process.stderr.write(m + "\n"); }
function out(m: string): void { process.stdout.write(m + "\n"); }

async function api<T>(method: string, url: string, token: string, body?: unknown): Promise<{ status: number; body: T | null }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  let j: T | null = null;
  try { j = (await res.json()) as T; } catch { /* non-JSON / 404 body */ }
  return { status: res.status, body: j };
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    err("Usage: /ashlr-genome-keygen [--force] [--dry-run] [--endpoint <url>]");
    return 0;
  }

  const token = readProToken();
  if (!token) {
    err("No Ashlr Pro token found. Run /ashlr-upgrade first.");
    return 2;
  }

  // Resolve user id.
  const me = await api<{ userId: string; email: string }>("GET", `${args.endpoint}/user/me`, token);
  if (me.status !== 200 || !me.body) {
    err(`Couldn't resolve your Ashlr account (status ${me.status}).`);
    return 3;
  }
  const userId = me.body.userId;

  // Current state.
  const localKp = loadKeypair(userId);
  const serverPk = await api<{ pubkey: string; alg: string }>(
    "GET", `${args.endpoint}/user/genome-pubkey`, token,
  );

  const haveLocal  = localKp !== null;
  const haveServer = serverPk.status === 200 && !!serverPk.body;
  const inSync     = haveLocal && haveServer && localKp!.publicKey === serverPk.body!.pubkey;

  if (inSync && !args.force) {
    out(`Already registered.`);
    out(`  pubkey: ${localKp!.publicKey}`);
    out(`  alg:    ${localKp!.alg}`);
    out(`  path:   ${memberKeyPath(userId)}`);
    return 0;
  }

  if (args.dryRun) {
    err("--dry-run: would generate a fresh X25519 keypair and upload the public half.");
    return 0;
  }

  // Generate.
  const { publicKey, privateKey } = generateKeyPair();
  const stored: StoredKeypair = {
    userId,
    publicKey,
    privateKey,
    alg: ALG,
    createdAt: new Date().toISOString(),
  };
  const path = saveKeypair(stored);

  // Upload.
  const up = await api<{ ok: boolean }>(
    "POST", `${args.endpoint}/user/genome-pubkey`, token,
    { pubkey: publicKey, alg: ALG },
  );
  if (up.status !== 200) {
    err(`Upload failed: HTTP ${up.status}`);
    return 3;
  }

  out(`Generated X25519 keypair.`);
  out(`  pubkey: ${publicKey}`);
  out(`  alg:    ${ALG}`);
  out(`  path:   ${path}`);
  out(``);
  out(`Your public key is now on file with Ashlr. Keep ${path} private — it is`);
  out(`the only way to decrypt team-cloud genomes shared with you.`);
  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => { err(`fatal: ${(e as Error).message}`); process.exit(1); });
}
