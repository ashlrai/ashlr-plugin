/**
 * _identity-hash.ts — WAD-D identity hashing.
 *
 * The WAD-D (weekly-active-developers-using-it-daily) north-star metric needs
 * a way to count *distinct developers* on the backend without ever learning
 * who any of them actually are. This module provides that anonymous identity.
 *
 * Identity scheme:
 *   - machineHash = sha256(machine_id + quarterly_salt)
 *     * machine_id is a stable random UUID stored at ~/.ashlr/machine-id,
 *       generated on first call. Never overwritten. No PII.
 *     * quarterly_salt = "salt_${year}Q${quarter}" derived deterministically
 *       from the current UTC date. Rotates every 3 months without any manual
 *       ops or remote config — the same client running 3 months later
 *       computes a *different* hash for the same machine_id. The backend
 *       therefore cannot reconstruct cross-quarter user identity.
 *
 *   - githubHash = sha256(github_login + quarterly_salt) IFF a Pro/Team
 *     token has been validated AND the cached UserMe payload includes a
 *     `githubLogin`. Otherwise `null` — never inferred, never guessed.
 *
 * Both hashes are hex-encoded sha256 (lowercase, 64 chars each). Identical
 * across calls within the same quarter; different across quarters.
 *
 * No new dependencies — uses Node's built-in `crypto.createHash`.
 */

import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function home(): string {
  return process.env.HOME ?? homedir();
}

export function machineIdPath(homeDir: string = home()): string {
  return join(homeDir, ".ashlr", "machine-id");
}

function proTokenCachePath(homeDir: string = home()): string {
  return join(homeDir, ".ashlr", "pro-token-cache.json");
}

// ---------------------------------------------------------------------------
// machine_id — read or generate
// ---------------------------------------------------------------------------

/**
 * Read the stable machine id from disk, generating one on first call.
 * Always returns a non-empty string. Never throws.
 */
export function getOrCreateMachineId(homeDir: string = home()): string {
  const p = machineIdPath(homeDir);
  try {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8").trim();
      if (raw.length > 0) return raw;
    }
  } catch {
    /* fall through to create */
  }
  const id = randomUUID();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, id, "utf-8");
  } catch {
    /* best-effort — in-memory id still returned */
  }
  return id;
}

// ---------------------------------------------------------------------------
// Quarterly salt — deterministic from current UTC year + quarter
// ---------------------------------------------------------------------------

/**
 * Derive the quarterly salt for a given Date (defaults to now, UTC).
 * Format: `salt_${year}Q${quarter}` where quarter ∈ {1, 2, 3, 4}.
 *
 * Exported so tests can mock the date input deterministically.
 */
export function quarterlySalt(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth(); // 0–11
  const quarter = Math.floor(monthIndex / 3) + 1; // 1–4
  return `salt_${year}Q${quarter}`;
}

// ---------------------------------------------------------------------------
// githubLogin — try to read from the pro-token cache (best-effort)
// ---------------------------------------------------------------------------

/**
 * Returns the github_login of the currently signed-in Pro/Team user, or null
 * when not signed in or when the cache doesn't include the field.
 *
 * This is intentionally tolerant: we never want a malformed cache or a
 * partial UserMe response to throw on the hot path.
 */
export function readGithubLoginFromCache(homeDir: string = home()): string | null {
  try {
    const p = proTokenCachePath(homeDir);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as { githubLogin?: unknown; valid?: unknown };
    if (parsed.valid !== true) return null;
    if (typeof parsed.githubLogin !== "string") return null;
    const login = parsed.githubLogin.trim();
    return login.length > 0 ? login : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface IdentityHash {
  /** sha256(machine_id + quarterly_salt) — hex, lowercase, 64 chars. */
  machineHash: string;
  /** sha256(github_login + quarterly_salt) when signed-in Pro/Team; else null. */
  githubHash: string | null;
}

/**
 * Compute the WAD-D identity hash pair. Defaults to "now" in UTC for the
 * quarterly salt; tests can pass an explicit `now` to verify quarter rotation.
 */
export function getIdentityHash(opts: { now?: Date; homeDir?: string } = {}): IdentityHash {
  const homeDir = opts.homeDir ?? home();
  const now = opts.now ?? new Date();
  const salt = quarterlySalt(now);

  const machineId = getOrCreateMachineId(homeDir);
  const machineHash = sha256Hex(machineId + salt);

  const login = readGithubLoginFromCache(homeDir);
  const githubHash = login ? sha256Hex(login + salt) : null;

  return { machineHash, githubHash };
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
