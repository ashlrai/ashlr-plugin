/**
 * bun-resolve.mjs — shared primitives for locating bun across:
 *   - scripts/bootstrap.mjs        (MCP server trampoline; also installs)
 *   - scripts/hook-bootstrap.mjs   (hook trampoline; never installs)
 *   - scripts/doctor.ts            (status reporting)
 *
 * Rationale: all three need the same "is bun reachable, and if not is it
 * already on disk under ~/.bun/bin" logic. Keeping that in one place means
 * the hook trampoline and doctor agree with bootstrap about what counts as
 * "installed" — otherwise doctor could falsely report missing while the
 * trampoline silently succeeds (or vice versa).
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join, resolve } from "node:path";

const IS_WINDOWS = platform() === "win32";

function userHome() {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export const BUN_BIN_DIR = join(userHome(), ".bun", "bin");

/** Absolute path to where the bun binary lives under ~/.bun/bin (.exe on Windows). */
export function bunBinaryPath() {
  return join(BUN_BIN_DIR, IS_WINDOWS ? "bun.exe" : "bun");
}

/** True when `bun --version` returns 0 via the current PATH. */
export function hasBun() {
  // Resolve to an absolute path ourselves rather than letting spawnSync
  // search PATH — the probe then runs a binary we located, not whatever a
  // later-mutated PATH happens to contain.
  const bun = resolveBunExecutable({ includeUserBin: false });
  if (!bun) return false;
  const result = spawnSync(bun, ["--version"], { stdio: "ignore", env: process.env });
  return result.status === 0;
}

/**
 * If ~/.bun/bin exists on disk, prepend it to process.env.PATH (only if not
 * already present). Safe to call multiple times. No-op if the dir is missing.
 */
export function prependBunToPath() {
  if (!existsSync(BUN_BIN_DIR)) return;
  const current = process.env.PATH || "";
  const parts = current.split(delimiter);
  if (!parts.includes(BUN_BIN_DIR)) {
    process.env.PATH = `${BUN_BIN_DIR}${delimiter}${current}`;
  }
}

/**
 * Returns the absolute path to the bun binary on disk if it exists there,
 * otherwise null. Used by doctor to distinguish "missing" from
 * "installed-but-not-on-PATH".
 */
export function bunBinaryOnDisk() {
  const p = bunBinaryPath();
  return existsSync(p) ? p : null;
}

// Extensions spawnable without a shell. `.cmd`/`.bat` shims are intentionally
// excluded: exec'ing them requires a shell, which is a worse trade than
// skipping that PATH entry.
const BUN_EXE_NAMES = IS_WINDOWS ? ["bun.exe", "bun.com"] : ["bun"];

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    if (IS_WINDOWS) return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path to the bun executable, or null when none is reachable.
 * Searches the directories on process.env.PATH in order, then ~/.bun/bin —
 * the same places execvp would look, except the search happens up front and
 * the winner is invoked by its absolute path instead of relying on the
 * child's PATH lookup.
 *
 * Pass `includeUserBin: false` to check PATH only (e.g. when deciding
 * whether ~/.bun/bin needs to be installed to or prepended).
 */
export function resolveBunExecutable({ includeUserBin = true } = {}) {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  if (includeUserBin && !dirs.includes(BUN_BIN_DIR)) dirs.push(BUN_BIN_DIR);
  for (const dir of dirs) {
    for (const name of BUN_EXE_NAMES) {
      const candidate = resolve(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}
