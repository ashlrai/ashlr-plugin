/**
 * _ast-refactor/file-local-rename.ts — File-local AST rename operations.
 *
 * Exports:
 *   planRenameInFile     — load + parse + plan rename for a file path
 *   planRenameFromParsed — pure variant operating on a pre-parsed tree (test-friendly)
 *
 * Invariants:
 *   - Never writes the file. Returns byte-range edits; the caller applies them.
 *   - Always refuses rather than producing a subtly-wrong rename.
 *   - Pure AST logic — no file-system side-effects beyond reading the source.
 */

import { parseFile, extractIdentifiers } from "../_ast-helpers";
import type { ParseResult } from "../_ast-helpers";
import {
  applyRangeEdits as _applyRangeEdits, // re-exported via facade
  validateIdentifier,
  isDeclarationSite,
  rangesToNodes,
  type RangeEdit,
  type RefactorKind,
} from "./_shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { RangeEdit, RefactorKind };

export interface RenameInFileOptions {
  /**
   * If set, only rename identifiers of this kind. Defaults to "value".
   * Use `"type"` to rename a type-only symbol (interface, type alias, etc.).
   */
  kind?: RefactorKind;
  /**
   * If true, ignore the shadowing guard and rename anyway. Default false.
   * Reserved for tests and advanced callers who've already verified safety.
   */
  force?: boolean;
}

export type RenameInFileResult =
  | {
      ok: true;
      edits: RangeEdit[];
      warnings: string[];
      references: number;
      /**
       * The exact source string the tree was parsed from. Callers applying
       * the edits MUST use this string (not a fresh re-read of the file) so
       * byte offsets stay aligned — a concurrent write between the initial
       * read and the rewrite would otherwise produce silently corrupt output.
       */
      source: string;
    }
  | {
      ok: false;
      reason: string;
      warnings?: string[];
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan a file-local rename.
 *
 * Loads + parses the file, collects identifier references matching
 * `{name, kind}`, checks the shadowing guard, and returns a list of byte
 * ranges to replace with `newName`.
 */
export async function planRenameInFile(
  filePath: string,
  oldName: string,
  newName: string,
  options: RenameInFileOptions = {},
): Promise<RenameInFileResult> {
  const kind: RefactorKind = options.kind ?? "value";

  const nameError = validateIdentifier(newName);
  if (nameError) return { ok: false, reason: nameError };
  if (oldName === newName) {
    return { ok: false, reason: "old and new names are identical" };
  }

  const parsed = await parseFile(filePath);
  if (!parsed) {
    return {
      ok: false,
      reason: "unsupported language or grammar not wired (ashlr__edit_structural supports .ts/.tsx/.js/.jsx today)",
    };
  }

  return planRenameFromParsed(parsed, oldName, newName, kind, options.force === true);
}

/**
 * Pure variant of {@link planRenameInFile} that operates on a pre-parsed
 * tree. Convenient for tests.
 */
export function planRenameFromParsed(
  parsed: ParseResult,
  oldName: string,
  newName: string,
  kind: RefactorKind,
  force = false,
): RenameInFileResult {
  const { tree, source } = parsed;

  const allRefs = extractIdentifiers(tree, source);
  const matches = allRefs.filter((r) => r.name === oldName && r.kind === kind);

  if (matches.length === 0) {
    return {
      ok: false,
      reason: `no ${kind}-position identifier named '${oldName}' found in file`,
    };
  }

  // Shadowing guard: count unique declaration sites. >1 means the same name
  // introduces multiple bindings (e.g., outer function + inner parameter).
  // Until we have proper scope resolution, refuse rather than silently
  // collide all of them.
  const warnings: string[] = [];
  const declarationMatches = rangesToNodes(tree, matches.map((m) => m.range)).filter(
    (n) => isDeclarationSite(n, kind),
  );
  const declarationCount = declarationMatches.length;

  if (declarationCount > 1 && !force) {
    return {
      ok: false,
      reason: `'${oldName}' has ${declarationCount} declaration sites in this file — rename refused to avoid shadowing collisions. Rename each scope individually or pass force:true after verifying safety.`,
    };
  }
  if (declarationCount === 0) {
    warnings.push(
      `no ${kind}-position declaration of '${oldName}' detected — identifier may be bound in an outer scope (imported / global). Rename applied only to the occurrences in this file.`,
    );
  }

  // Check the new name doesn't already collide with a declaration of the
  // same kind in the file.
  if (!force) {
    const collision = allRefs.some(
      (r) => r.name === newName && r.kind === kind,
    );
    if (collision) {
      return {
        ok: false,
        reason: `'${newName}' already exists as a ${kind}-position identifier in this file — would collide. Rename to a different name, or pass force:true.`,
      };
    }
  }

  const edits: RangeEdit[] = matches.map((m) => ({
    start: m.range[0],
    end: m.range[1],
    replacement: newName,
  }));

  return {
    ok: true,
    edits,
    warnings,
    references: matches.length,
    source,
  };
}
