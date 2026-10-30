/**
 * locus-resolve.ts — locate the `locus` CLI ourselves instead of letting
 * child_process search PATH at exec time (Sonar S4036). The lookup mirrors
 * execvp semantics — PATH directories in order — then falls back to the
 * standard install locations, and the winner is spawned by absolute path.
 *
 * Mirrors scripts/bun-resolve.mjs, which does the same for `bun`.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join, resolve } from "node:path";

const IS_WINDOWS = platform() === "win32";
// `.cmd`/`.bat` shims are intentionally excluded: exec'ing them requires a
// shell, which is a worse trade than skipping that PATH entry.
const LOCUS_EXE_NAMES = IS_WINDOWS ? ["locus.exe", "locus.com"] : ["locus"];

function userHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/** PATH directories first (execvp order), then `cargo install` / package-manager locations. */
function searchDirs(): string[] {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const fallbacks = [join(userHome(), ".cargo", "bin"), join(userHome(), ".local", "bin")];
  if (!IS_WINDOWS) fallbacks.push("/usr/local/bin", "/opt/homebrew/bin");
  for (const dir of fallbacks) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (IS_WINDOWS) return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to the locus executable, or null when none is reachable. */
export function resolveLocusExecutable(): string | null {
  for (const dir of searchDirs()) {
    for (const name of LOCUS_EXE_NAMES) {
      const candidate = resolve(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}
