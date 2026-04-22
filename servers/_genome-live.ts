/**
 * _genome-live.ts — in-process genome section refresh after ashlr__edit.
 *
 * When ashlr__edit writes a file, call refreshGenomeAfterEdit to patch any
 * genome sections that embed the edited content verbatim. Sections that only
 * summarize the file (no literal content match) are invalidated (deleted) so
 * the propose queue regenerates them.
 *
 * Design constraints:
 *   - Never throws — returns {updated:0,skipped:0} on any failure.
 *   - Fire-and-forget safe: callers use .catch(()=>{}) and never await.
 *   - Honors ASHLR_GENOME_AUTO=0 as a kill switch.
 *   - File-level serialization via a simple in-process mutex Map.
 *   - Calls _clearCache() so the LRU evicts stale genome retrievals.
 */

import { readFile, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { dirname, basename, join } from "path";

import {
  genomeExists,
  loadManifest,
  saveManifest,
  sectionPath,
  type GenomeManifest,
} from "@ashlr/core-efficiency/genome";
import { _clearCache } from "./_genome-cache";

const MAX_GENOME_WALK = 8;

/**
 * Walk up from `startDir` (inclusive) looking for a directory that contains
 * `.ashlrcode/genome/manifest.json`. No $HOME cap — this is an internal
 * helper used only after a write, so we trust the path is valid.
 */
function findGenomeRoot(startDir: string): string | null {
  let current = startDir;
  for (let i = 0; i <= MAX_GENOME_WALK; i++) {
    if (genomeExists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null; // filesystem root
    current = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RefreshResult {
  updated: number;
  skipped: number;
}

/**
 * After a successful ashlr__edit, patch genome sections that reference the
 * edited file. Verbatim sections get a string-replace; summarized sections
 * are deleted so the propose queue can regenerate them.
 *
 * @param absolutePath  Absolute path of the file that was edited.
 * @param editBefore    The `search` string that was replaced.
 * @param editAfter     The `replace` string that was inserted.
 */
export async function refreshGenomeAfterEdit(
  absolutePath: string,
  editBefore: string,
  editAfter: string,
): Promise<RefreshResult> {
  // Kill switch — same flag genome-auto-propose.ts respects.
  if (process.env.ASHLR_GENOME_AUTO === "0") {
    return { updated: 0, skipped: 0 };
  }

  try {
    return await _refreshSafe(absolutePath, editBefore, editAfter);
  } catch {
    return { updated: 0, skipped: 0 };
  }
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

/**
 * Simple per-genomeRoot serialization mutex.
 * Two concurrent edits to files under the same genome root are sequenced so
 * both manifest read-modify-writes land coherently.
 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next: Promise<T> = prev.then(fn, fn as () => Promise<T>);
  // best-effort: this `settled` shadow exists only to break rejection chaining for the *next* lock waiter; the real error still rides on `next` and is returned to the caller.
  const settled = next.catch(() => {});
  locks.set(key, settled);
  settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}

async function _refreshSafe(
  absolutePath: string,
  editBefore: string,
  editAfter: string,
): Promise<RefreshResult> {
  // Resolve genome root — walk up from the file's directory checking for a
  // genome at each level. We check the file's own dir first (unlike
  // findParentGenome which skips startDir), then ancestors up to 8 levels.
  // We don't apply the $HOME cap here because edited files may be anywhere
  // (e.g. tmpdir during tests, or monorepo subdirs outside HOME).
  const fileDir = dirname(absolutePath) || "/";
  const genomeRoot = findGenomeRoot(fileDir);

  if (!genomeRoot) return { updated: 0, skipped: 0 };

  return withLock(genomeRoot, () =>
    _refreshUnderLock(genomeRoot!, absolutePath, editBefore, editAfter),
  );
}

async function _refreshUnderLock(
  genomeRoot: string,
  absolutePath: string,
  editBefore: string,
  editAfter: string,
): Promise<RefreshResult> {
  const manifest = await loadManifest(genomeRoot);
  if (!manifest) return { updated: 0, skipped: 0 };

  // Find sections that reference this file. The heuristic: a section's path
  // component or its content will mention the file's basename / relative path.
  // We check section *content* for the actual literal match — not the section
  // path — because a section can embed any number of files.
  const matchingSections = await findSectionsForFile(
    genomeRoot,
    manifest,
    absolutePath,
  );

  if (matchingSections.length === 0) return { updated: 0, skipped: 0 };

  let updated = 0;
  let skipped = 0;
  let manifestDirty = false;

  for (const sectionRel of matchingSections) {
    const absSection = sectionPath(genomeRoot, sectionRel);
    let sectionContent: string;
    try {
      sectionContent = await readFile(absSection, "utf-8");
    } catch {
      skipped++;
      continue;
    }

    if (isVerbatim(sectionContent, editBefore)) {
      // Literal content found — patch in place.
      const patched = sectionContent.split(editBefore).join(editAfter);
      try {
        await writeFile(absSection, patched, "utf-8");
        // Update the section's updatedAt in the manifest.
        const idx = manifest.sections.findIndex((s) => s.path === sectionRel);
        if (idx >= 0) {
          manifest.sections[idx]!.updatedAt = new Date().toISOString();
          manifestDirty = true;
        }
        updated++;
      } catch {
        skipped++;
      }
    } else {
      // Summarized section — invalidate by deleting. The propose queue will
      // regenerate it on the next SessionEnd or ≥3-proposal flush.
      try {
        await unlink(absSection);
        // Remove the section from the manifest.
        const idx = manifest.sections.findIndex((s) => s.path === sectionRel);
        if (idx >= 0) {
          manifest.sections.splice(idx, 1);
          manifestDirty = true;
        }
        skipped++; // counted as skipped (invalidated, not patched)
      } catch {
        skipped++;
      }
    }
  }

  if (manifestDirty) {
    manifest.updatedAt = new Date().toISOString();
    await saveManifest(genomeRoot, manifest);
    // Evict in-process LRU so future ashlr__grep calls re-read from disk.
    _clearCache();
  }

  return { updated, skipped };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find section relative paths whose content references `absolutePath`.
 *
 * Strategy: read each section file and check whether it mentions the file
 * (by absolute path, or by the filename). We only look at sections that have
 * a non-trivial probability of embedding the file — sections whose title,
 * summary, or tags contain the filename are strong candidates; we also check
 * all sections by content to catch unlabeled embeds.
 */
async function findSectionsForFile(
  genomeRoot: string,
  manifest: GenomeManifest,
  absolutePath: string,
): Promise<string[]> {
  const fileName = basename(absolutePath);
  const results: string[] = [];

  for (const section of manifest.sections) {
    const absSection = sectionPath(genomeRoot, section.path);
    if (!existsSync(absSection)) continue;

    // Fast pre-filter: does the manifest metadata hint at this file?
    const metaHint =
      section.title.includes(fileName) ||
      section.summary.includes(fileName) ||
      section.tags.some((t) => t.includes(fileName)) ||
      section.path.includes(fileName);

    let sectionContent: string;
    try {
      sectionContent = await readFile(absSection, "utf-8");
    } catch {
      continue;
    }

    // Check if the section content references the file path or filename.
    if (
      metaHint ||
      sectionContent.includes(absolutePath) ||
      sectionContent.includes(fileName)
    ) {
      results.push(section.path);
    }
  }

  return results;
}

/**
 * Return true when the section content contains a fenced code block that
 * includes `editBefore` verbatim, OR when `editBefore` appears literally
 * anywhere in the section content (covers inline snippets too).
 */
function isVerbatim(sectionContent: string, editBefore: string): boolean {
  return sectionContent.includes(editBefore);
}
