/**
 * _ast-refactor.ts — Facade re-exporting the public API of the AST-refactor
 * module family (Track D, v1.24).
 *
 * The implementation has been decomposed into focused sub-modules:
 *   _ast-refactor/_shared.ts           — common types, helpers, applyRangeEdits
 *   _ast-refactor/file-local-rename.ts — planRenameInFile + planRenameFromParsed
 *   _ast-refactor/cross-file-rename.ts — planCrossFileRename + applyCrossFileRenameEdits
 *   _ast-refactor/extract-function.ts  — planExtractFunction
 *
 * All public signatures are identical to the monolithic v1.18.1 version.
 * Callers (edit-structural-server-handlers.ts, tests) are unaffected.
 */

export type { RangeEdit, RefactorKind } from "./_ast-refactor/_shared";
export { applyRangeEdits } from "./_ast-refactor/_shared";

export type {
  RenameInFileOptions,
  RenameInFileResult,
} from "./_ast-refactor/file-local-rename";
export {
  planRenameInFile,
  planRenameFromParsed,
} from "./_ast-refactor/file-local-rename";

export type {
  CrossFileRenameOptions,
  CrossFileFileEdit,
  CrossFileRenameResult,
} from "./_ast-refactor/cross-file-rename";
export {
  planCrossFileRename,
  applyCrossFileRenameEdits,
} from "./_ast-refactor/cross-file-rename";

export type {
  ExtractFunctionOptions,
  ExtractFunctionResult,
} from "./_ast-refactor/extract-function";
export { planExtractFunction } from "./_ast-refactor/extract-function";
