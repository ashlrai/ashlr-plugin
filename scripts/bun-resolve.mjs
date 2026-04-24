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
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

const IS_WINDOWS = platform() === "win32";

export const BUN_BIN_DIR = join(homedir(), ".bun", "bin");

/** Absolute path to where the bun binary lives under ~/.bun/bin (.exe on Windows). */
export function bunBinaryPath() {
  return join(BUN_BIN_DIR, IS_WINDOWS ? "bun.exe" : "bun");
}

/** True when `bun --version` returns 0 via the current PATH. */
export function hasBun() {
  const result = spawnSync("bun", ["--version"], { stdio: "ignore" });
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
