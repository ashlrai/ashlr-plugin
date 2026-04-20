/**
 * _ast-refactor.ts — AST-aware refactor operations (Track C, v1.13).
 *
 * v1.13 scope: **file-local rename**, name + kind match (value vs type),
 * with a conservative shadowing guard that refuses when the target name
 * has multiple declaration sites in the file. Cross-file rename and real
 * scope-aware binding resolution (closures, nested shadowing) are v1.14.
 *
 * Invariants:
 *   - Always refuses rather than producing a subtly-wrong rename. Call
 *     sites that hit a `refused` result should surface the reason to the
 *     agent so it knows to fall back to a broader-scope tool.
 *   - Never writes the file. Returns byte-range edits; the caller (handler
 *     module or tests) applies them.
 *   - Pure AST logic — no file-system side-effects; tests pass source
 *     strings directly when useful.
 */

import type Parser from "web-tree-sitter";
import {
  extractIdentifiers,
  parseFile,
  type ParseResult,
} from "./_ast-helpers";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single byte-range edit. Replaces `[start, end)` with `replacement`.
 * Compatible with the shape needed by an in-place file write.
 */
export interface RangeEdit {
  start: number;
  end: number;
  replacement: string;
}

export type RefactorKind = "value" | "type";

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
    }
  | {
      ok: false;
      reason: string;
      warnings?: string[];
    };

// ---------------------------------------------------------------------------
// Declaration detection
// ---------------------------------------------------------------------------

/**
 * Parent-node types whose identifier child is a binding *declaration* site.
 * Used by the shadowing guard to decide whether multiple same-name
 * identifiers in the file actually introduce distinct bindings (→ refuse)
 * or are just references to a single declaration (→ safe to rename).
 */
const VALUE_DECLARATION_PARENTS = new Set([
  "variable_declarator",        // const X = …
  "function_declaration",       // function X() {}
  "function_signature",         // declare function X()
  "method_definition",          // class body: X() {}
  "class_declaration",          // class X {}
  "required_parameter",         // fn(X: T)
  "optional_parameter",         // fn(X?: T)
  "rest_parameter",             // fn(...X: T[])
  "formal_parameters",          // bare parameter id
  "import_specifier",           // import { X }
  "import_clause",              // import X from …
  "namespace_import",           // import * as X from …
  "enum_declaration",           // enum X {}
]);

const TYPE_DECLARATION_PARENTS = new Set([
  "type_alias_declaration",     // type X = …
  "interface_declaration",      // interface X {}
  "enum_declaration",           // enum X {} (also type-side)
  "type_parameter",             // generic <X>
]);

/**
 * Pattern-wrapper node types that can sit between an identifier and its
 * declaration parent (e.g., `const { a } = obj` → identifier → object_pattern
 * → variable_declarator). We walk upward THROUGH these, but refuse to skip
 * arbitrary expressions — otherwise `const x = a + b` would count `a` as a
 * declaration of itself (since its grandparent is `variable_declarator`).
 */
const PATTERN_INTERMEDIATE_TYPES = new Set([
  "array_pattern",
  "object_pattern",
  "pair_pattern",
  "rest_pattern",
  "assignment_pattern",
  "object_assignment_pattern",
]);

function isDeclarationSite(node: Parser.SyntaxNode, kind: RefactorKind): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const set = kind === "value" ? VALUE_DECLARATION_PARENTS : TYPE_DECLARATION_PARENTS;
  if (set.has(parent.type)) return true;
  // Walk upward ONLY through pattern intermediate nodes (destructuring).
  // Skipping through arbitrary expressions misidentifies every identifier
  // inside an initializer as a declaration of itself.
  if (!PATTERN_INTERMEDIATE_TYPES.has(parent.type)) return false;
  let up: Parser.SyntaxNode | null = parent.parent;
  while (up && PATTERN_INTERMEDIATE_TYPES.has(up.type)) up = up.parent;
  return up !== null && set.has(up.type);
}

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
  };
}

/**
 * Apply a set of byte-range edits to a source string. Edits are sorted
 * right-to-left so offsets stay valid during the rewrite. Overlapping
 * ranges (which should never come out of planRenameInFile) are detected
 * and throw.
 */
export function applyRangeEdits(source: string, edits: RangeEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  let prevStart: number | null = null;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end > source.length || edit.start > edit.end) {
      throw new Error(
        `applyRangeEdits: invalid range [${edit.start}, ${edit.end}] for source of length ${source.length}`,
      );
    }
    if (prevStart !== null && edit.end > prevStart) {
      throw new Error(
        `applyRangeEdits: overlapping edits at [${edit.start}, ${edit.end}] vs prior start ${prevStart}`,
      );
    }
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
    prevStart = edit.start;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Basic JS/TS identifier syntax check. */
function validateIdentifier(name: string): string | null {
  if (!name) return "new name is empty";
  // First char: letter | _ | $ — ASCII only for v1.13; full Unicode later.
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    return `'${name}' is not a valid ASCII JS identifier`;
  }
  // Refuse reserved words proactively so the edit doesn't brick the file.
  const RESERVED = new Set([
    "break","case","catch","class","const","continue","debugger","default",
    "delete","do","else","enum","export","extends","false","finally","for",
    "function","if","import","in","instanceof","new","null","return","super",
    "switch","this","throw","true","try","typeof","var","void","while","with",
    "yield","let","static","async","await",
  ]);
  if (RESERVED.has(name)) return `'${name}' is a reserved word`;
  return null;
}

/** Resolve a list of [start, end] ranges back to concrete tree nodes. */
function rangesToNodes(tree: Parser.Tree, ranges: Array<[number, number]>): Parser.SyntaxNode[] {
  const wanted = new Set(ranges.map((r) => `${r[0]}:${r[1]}`));
  const out: Parser.SyntaxNode[] = [];
  walk(tree.rootNode, (n) => {
    if (wanted.has(`${n.startIndex}:${n.endIndex}`)) out.push(n);
  });
  return out;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  const children = node.children;
  for (let i = 0; i < children.length; i++) walk(children[i]!, visit);
}
