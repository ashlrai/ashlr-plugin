/**
 * genome-link — walk up parent directories looking for a genome.
 *
 * When a project has no `.ashlrcode/genome/` of its own, ashlr tools can fall
 * back to a genome in an ancestor directory (e.g. a workspace-level genome at
 * `~/Desktop/.ashlrcode/genome/`). This module locates that ancestor.
 *
 * The walk stops at whichever comes first:
 *   - a directory containing `.ashlrcode/genome/manifest.json`
 *   - `$HOME` (we never look at `$HOME` itself or above — user-level genomes
 *     are out of scope; we want *workspace* genomes)
 *   - the filesystem root
 *   - `maxDepth` parents (default 4)
 */
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, sep } from "path";

const GENOME_MANIFEST_REL = ".ashlrcode/genome/manifest.json";
const DEFAULT_MAX_DEPTH = 4;

function hasGenome(dir: string): boolean {
  return existsSync(join(dir, GENOME_MANIFEST_REL));
}

/**
 * Walk up from `startDir` looking for the first ancestor that contains
 * `.ashlrcode/genome/manifest.json`. Returns that directory's absolute path,
 * or `null` if none is found within `maxDepth` steps.
 *
 * The walk skips `startDir` itself — callers should check the current dir
 * separately via `genomeExists(cwd)`. We stop before reaching `$HOME` so we
 * don't accidentally attach a user-level genome to an unrelated project.
 */
export function findParentGenome(
  startDir: string,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): string | null {
  const home = resolve(homedir());
  let current = resolve(startDir);
  let depth = 0;

  while (depth < maxDepth) {
    const parent = dirname(current);
    // Stop at filesystem root (dirname of "/" is "/") to avoid infinite loop.
    if (parent === current) return null;
    // Stop when we'd cross into or above $HOME — workspace genomes only,
    // user-level (~/.ashlrcode) is out of scope.
    if (parent === home) return null;
    // Safety: if we somehow walked outside the $HOME subtree, bail.
    if (!parent.startsWith(home + sep)) return null;

    if (hasGenome(parent)) return parent;

    current = parent;
    depth++;
  }
  return null;
}
