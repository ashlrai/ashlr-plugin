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
import { levenshtein as _levenshtein, fuzzyTopLines, findFuzzyMatch } from "./_edit-match";
import { validateEdit } from "./_edit-validate";

// Re-export levenshtein so tests / other modules that may import it from here
// continue to work (backwards-compat shim).
export { _levenshtein as levenshtein };

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

  // -------------------------------------------------------------------------
  // Zero-match: try fuzzy fallback (Feature 2) before throwing.
  // -------------------------------------------------------------------------
  if (count === 0) {
    // Fuzzy is only attempted in strict mode, for files <= 2 MB, when not disabled.
    const fuzzyEnabled =
      strict &&
      original.length <= FUZZY_SIZE_LIMIT &&
      process.env.ASHLR_EDIT_FUZZY !== "off";

    if (fuzzyEnabled) {
      const fuzzyMatch = findFuzzyMatch(original, search);
      if (fuzzyMatch !== null) {
        // Confident, unique match found — apply it.
        const updated =
          original.slice(0, fuzzyMatch.start) +
          replace +
          original.slice(fuzzyMatch.end);

        // Validate before write (Feature 3).
        const validation = await validateEdit(abs, original, updated).catch(() => ({
          introducedError: false,
          detail: "",
        }));

        if (
          validation.introducedError &&
          process.env.ASHLR_EDIT_VALIDATE === "block"
        ) {
          throw new Error(
            `ashlr__edit: refused — edit introduces a syntax error (${validation.detail}); ` +
              `set ASHLR_EDIT_VALIDATE=warn to override`,
          );
        }

        await writeFile(abs, updated, "utf-8");
        invalidateCached(abs);
        refreshGenomeAfterEdit(abs, original, updated).catch(() => {});

        const baseBytes = search.length + replace.length;
        const compactSummary = summarizeEdit(relPath, search, replace, 1, true);
        await recordSaving(baseBytes, compactSummary.length, "ashlr__edit");

        appendEdit({ relPath, hunksApplied: 1 });

        let resultText =
          compactSummary +
          `\n[ashlr__edit: applied via fuzzy match (sim=${fuzzyMatch.score.toFixed(2)}) — verify the diff]`;

        if (validation.introducedError) {
          resultText +=
            `\n[ashlr__edit: ⚠ syntax — this edit introduces a parse error (${validation.detail}); review or fix in your next edit]`;
        }

        return { text: resultText, hunksApplied: 1 };
      }
    }

    // No fuzzy match (or fuzzy disabled) — throw the existing enriched error.
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

  // -------------------------------------------------------------------------
  // Normal exact-match path (unchanged semantics).
  // -------------------------------------------------------------------------

  // Treat replacement as literal text. String.prototype.replace(string, string)
  // interprets `$&`, `$1`, `$'`, and `$` sequences in the replacement.
  const matchIdx = original.indexOf(search);
  const updated = strict
    ? original.slice(0, matchIdx) + replace + original.slice(matchIdx + search.length)
    : original.split(search).join(replace);

  // Feature 3: validate before writing.
  const validation = await validateEdit(abs, original, updated).catch(() => ({
    introducedError: false,
    detail: "",
  }));

  if (
    validation.introducedError &&
    process.env.ASHLR_EDIT_VALIDATE === "block"
  ) {
    throw new Error(
      `ashlr__edit: refused — edit introduces a syntax error (${validation.detail}); ` +
        `set ASHLR_EDIT_VALIDATE=warn to override`,
    );
  }

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

  let resultText = compactSummary;

  // Feature 3: append warning if edit introduced a syntax error (warn mode).
  if (validation.introducedError) {
    resultText +=
      `\n[ashlr__edit: ⚠ syntax — this edit introduces a parse error (${validation.detail}); review or fix in your next edit]`;
  }

  return { text: resultText, hunksApplied };
}
