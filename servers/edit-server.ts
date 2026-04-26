/**
 * edit-server — ashlr__edit tool implementation.
 *
 * Owns the search/replace + diff-summary pipeline. Three post-edit
 * side-effects (in order):
 *   1. readCache invalidate  — so subsequent ashlr__read sees fresh content
 *   2. refreshGenomeAfterEdit (fire-and-forget) — keeps genome in sync
 *   3. editLog append        — feeds ashlr__flush summary
 */

import { readFile, writeFile } from "fs/promises";
import { estimateTokensFromString } from "@ashlr/core-efficiency";
import { refreshGenomeAfterEdit } from "./_genome-live";
import { recordSaving } from "./_stats";
import { clampToCwd } from "./_cwd-clamp";
import { invalidateCached } from "./_read-cache";
import { appendEdit } from "./_edit-log";

export interface EditArgs {
  path: string;
  search: string;
  replace: string;
  /** When true (default), require exactly one match of `search` for safety. */
  strict?: boolean;
}

export interface EditResult {
  text: string;
  hunksApplied: number;
}

/** Levenshtein distance (capped at maxDist for speed). */
function levenshtein(a: string, b: string, maxDist = 256): number {
  if (a === b) return 0;
  if (a.length === 0) return Math.min(b.length, maxDist);
  if (b.length === 0) return Math.min(a.length, maxDist);
  const A = a.slice(0, 200);
  const B = b.slice(0, 200);
  const m = A.length, n = B.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Return top-3 closest lines to `search` from `content`, with similarity scores. */
function fuzzyTopLines(
  search: string,
  content: string,
): Array<{ lineNo: number; text: string; sim: number }> {
  const needle = search.split("\n")[0].trim().slice(0, 200);
  const lines = content.split("\n");
  const results: Array<{ lineNo: number; text: string; sim: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const dist = levenshtein(needle, line.slice(0, 200));
    const maxLen = Math.max(needle.length, line.length, 1);
    const sim = Math.round((1 - dist / maxLen) * 100) / 100;
    results.push({ lineNo: i + 1, text: lines[i], sim });
  }
  results.sort((a, b) => b.sim - a.sim);
  return results.slice(0, 3);
}

const FUZZY_SIZE_LIMIT = 2 * 1024 * 1024; // 2 MB

function summarizeEdit(
  relPath: string,
  search: string,
  replace: string,
  matchCount: number,
  strict: boolean,
): string {
  const first = (s: string) => s.split("\n")[0]?.slice(0, 72) ?? "";
  return [
    `[ashlr__edit] ${relPath}  ·  ${strict ? "1 of " + matchCount : matchCount + " of " + matchCount} hunks applied`,
    `  - removed (${estimateTokensFromString(search)} tok):  ${first(search)}${search.length > 72 ? "…" : ""}`,
    `  + added   (${estimateTokensFromString(replace)} tok):  ${first(replace)}${replace.length > 72 ? "…" : ""}`,
  ].join("\n");
}

export async function ashlrEdit(input: EditArgs): Promise<EditResult> {
  const { path: relPath, search, replace, strict = true } = input;
  if (!search) throw new Error("ashlr__edit: 'search' must not be empty");

  const clamp = clampToCwd(relPath, "ashlr__edit");
  if (!clamp.ok) throw new Error(clamp.message);
  const abs = clamp.abs;
  const original = await readFile(abs, "utf-8");

  let count = 0;
  let idx = 0;
  while ((idx = original.indexOf(search, idx)) !== -1) { count++; idx += search.length; }

  if (count === 0) {
    if (strict && original.length <= FUZZY_SIZE_LIMIT) {
      const candidates = fuzzyTopLines(search, original);
      const hint = candidates.length
        ? "\nClosest lines in file:\n" +
          candidates.map(c => `  ${c.lineNo}:  ${c.text.slice(0, 120)}  (sim=${c.sim.toFixed(2)})`).join("\n")
        : "";
      throw new Error(`ashlr__edit: no match for search string in ${relPath} (strict mode).${hint}`);
    }
    throw new Error(`ashlr__edit: search string not found in ${relPath}`);
  }
  if (strict && count > 1) {
    throw new Error(
      `ashlr__edit: search string matched ${count} times in ${relPath}; pass strict:false to replace all, or widen the context to a unique span.`,
    );
  }

  const updated = strict
    ? original.replace(search, replace)
    : original.split(search).join(replace);

  await writeFile(abs, updated, "utf-8");

  // Post-edit side-effects (order preserved from efficiency-server.ts:847-902):

  // 1. Invalidate read-cache so subsequent ashlr__read calls see new content.
  invalidateCached(abs);

  // 2. best-effort: refreshGenomeAfterEdit already swallows internally; this
  //    outer catch guards against a pre-try sync throw.
  refreshGenomeAfterEdit(abs, original, updated).catch(() => {});

  // v1.18 Trust Pass: baseline is what Claude Code would have SENT for a
  // native Edit — search + replace, NOT the full file twice.
  // v1.22 refinement: multi-hunk strict=false edits replace ALL N matches in
  // a single ashlr call. Native equivalent is one Edit with replace_all=true
  // (still 1 call) but Claude must reason about all N occurrences when crafting
  // the call — add a small file-context premium (+500 bytes) so multi-hunk
  // savings reflect the cognitive overhead of the original LLM call without
  // multiplying by `count` (which would inflate 5-10×).
  const baseBytes = search.length + replace.length;
  const naiveBytes = !strict && count > 1 ? baseBytes + 500 : baseBytes;
  const compactSummary = summarizeEdit(relPath, search, replace, count, strict);
  await recordSaving(naiveBytes, compactSummary.length, "ashlr__edit");

  const hunksApplied = strict ? 1 : count;

  // 3. Append to edit log (feeds ashlr__flush summary).
  appendEdit({ relPath, hunksApplied });

  return { text: compactSummary, hunksApplied };
}
