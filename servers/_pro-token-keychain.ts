/**
 * OS keychain storage for ASHLR_PRO_TOKEN, with the old plaintext
 * ~/.ashlr/env line as the fallback.
 *
 * macOS: `security -i` (login keychain, token on stdin). Linux: `secret-tool` (libsecret), which
 * reads the secret from stdin. Anything else, or a backend that fails, falls
 * back to the 0600 `export ASHLR_PRO_TOKEN=` line in ~/.ashlr/env.
 * ASHLR_KEYCHAIN=0 turns the keychain off entirely.
 *
 * Token values are never logged or put in error messages.
 */

import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

export const KEYCHAIN_SERVICE = "ashlr-plugin";
export const KEYCHAIN_ACCOUNT = "ASHLR_PRO_TOKEN";
const ENV_LINE_PREFIX = "export ASHLR_PRO_TOKEN=";
/** The one-line warning shown when the token had to go to the plaintext file. */
export const PLAINTEXT_FALLBACK_WARNING =
  "No usable OS keychain; ASHLR_PRO_TOKEN saved in plain text to ~/.ashlr/env (mode 0600).";
const SAFE_TOKEN = /^[A-Za-z0-9._~+\/=:-]+$/;

export interface RunResult {
  status: number | null;
  stdout: string;
}
export type Runner = (cmd: string, args: string[], input?: string) => RunResult;

export interface KeychainDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
}

const defaultRunner: Runner = (cmd, args, input) => {
  try {
    const r = spawnSync(cmd, args, {
      input,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? "" };
  } catch {
    return { status: null, stdout: "" };
  }
};

function backend(deps: KeychainDeps): "darwin" | "linux" | null {
  const env = deps.env ?? process.env;
  if (env["ASHLR_KEYCHAIN"] === "0") return null;
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  return null;
}

/** Store the token in the OS keychain. True only when the backend succeeded. */
export function keychainStore(token: string, deps: KeychainDeps = {}): boolean {
  const run = deps.run ?? defaultRunner;
  const b = backend(deps);
  if (!b || !token) return false;
  if (b === "darwin") {
    // `security -i` reads the command from stdin, so the token never sits on
    // argv (visible to `ps`). Its parser splits on whitespace and quotes, so
    // only tokens of plain token characters go this way; anything else is
    // left to the file fallback rather than risk a mangled value.
    if (!SAFE_TOKEN.test(token)) return false;
    return run(
      "security",
      ["-i"],
      `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${token}\n`,
    ).status === 0;
  }
  return run(
    "secret-tool",
    ["store", "--label=ashlr-plugin pro token", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
    token,
  ).status === 0;
}

/** Read the token from the OS keychain, or null. */
export function keychainLoad(deps: KeychainDeps = {}): string | null {
  const run = deps.run ?? defaultRunner;
  const b = backend(deps);
  if (!b) return null;
  const r = b === "darwin"
    ? run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"])
    : run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]);
  if (r.status !== 0) return null;
  const t = r.stdout.trim();
  return t || null;
}

function readEnv(envFile: string): string {
  try { return readFileSync(envFile, "utf8"); } catch { return ""; }
}

function writeEnv(envFile: string, lines: string[]): void {
  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
  const body = lines.join("\n").trim();
  writeFileSync(envFile, body ? body + "\n" : "", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(envFile, 0o600); } catch { /* best-effort */ }
}

/** The token on the env file's `export ASHLR_PRO_TOKEN=` line, or null. */
export function envFileToken(envFile: string): string | null {
  for (const line of readEnv(envFile).split("\n")) {
    if (!line.startsWith(ENV_LINE_PREFIX)) continue;
    let v = line.slice(ENV_LINE_PREFIX.length).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v || null;
  }
  return null;
}

function withoutTokenLine(envFile: string): string[] {
  return readEnv(envFile).split("\n").filter((l) => !l.startsWith(ENV_LINE_PREFIX));
}

/**
 * Save the token: keychain first (and drop any plaintext line), otherwise the
 * plaintext env line. Returns where it went.
 */
export function storeProToken(token: string, envFile: string, deps: KeychainDeps = {}): "keychain" | "file" {
  if (keychainStore(token, deps) && keychainLoad(deps) === token) {
    if (existsSync(envFile)) writeEnv(envFile, withoutTokenLine(envFile));
    return "keychain";
  }
  const lines = withoutTokenLine(envFile);
  lines.push(`${ENV_LINE_PREFIX}${token}`);
  writeEnv(envFile, lines);
  return "file";
}

/**
 * One-time migration: move a plaintext env-file token into the keychain. The
 * line is removed only after the keychain reads the same value back, so a
 * failed or partial store never loses the token.
 */
export function migrateEnvFileToken(envFile: string, deps: KeychainDeps = {}): "migrated" | "none" | "kept" {
  const token = envFileToken(envFile);
  if (!token) return "none";
  if (!keychainStore(token, deps) || keychainLoad(deps) !== token) return "kept";
  writeEnv(envFile, withoutTokenLine(envFile));
  return "migrated";
}
