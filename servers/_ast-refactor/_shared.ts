/**
 * _ast-refactor/_shared.ts — Shared types, constants, and helpers for all
 * AST-refactor operations (file-local rename, cross-file rename,
 * extract-function).
 *
 * Nothing in this module has file-system side-effects. It is pure logic
 * operating on tree-sitter trees and source strings.
 */

import type Parser from "web-tree-sitter";
import { walkNodes } from "../_ast-helpers";

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

// ---------------------------------------------------------------------------
// Declaration detection constants
// ---------------------------------------------------------------------------

/**
 * Parent-node types whose identifier child is a binding *declaration* site.
 * Used by the shadowing guard to decide whether multiple same-name
 * identifiers in the file actually introduce distinct bindings (→ refuse)
 * or are just references to a single declaration (→ safe to rename).
 */
export const VALUE_DECLARATION_PARENTS = new Set([
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

export const TYPE_DECLARATION_PARENTS = new Set([
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
export const PATTERN_INTERMEDIATE_TYPES = new Set([
  "array_pattern",
  "object_pattern",
  "pair_pattern",
  "rest_pattern",
  "assignment_pattern",
  "object_assignment_pattern",
]);

// ---------------------------------------------------------------------------
// Node comparison helpers
// ---------------------------------------------------------------------------

/**
 * Compare two SyntaxNode references by byte range. web-tree-sitter does NOT
 * guarantee reference stability — `parent.childForFieldName("name")` returns
 * a fresh JS object each call, so `===` always fails even when the underlying
 * node is the same. Comparing start/end indexes is the canonical approach.
 */
export function sameNode(a: Parser.SyntaxNode | null, b: Parser.SyntaxNode | null): boolean {
  if (!a || !b) return false;
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

// ---------------------------------------------------------------------------
// Declaration site detection
// ---------------------------------------------------------------------------

export function isDeclarationSite(node: Parser.SyntaxNode, kind: RefactorKind): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const set = kind === "value" ? VALUE_DECLARATION_PARENTS : TYPE_DECLARATION_PARENTS;
  if (set.has(parent.type)) {
    // Field-aware check: in a variable_declarator the identifier at field
    // `name` is the binding, and the identifier at field `value` is a
    // reference to another binding. Without this check,
    //   const msg = greet;
    // counts `greet` (the initializer) as a declaration of itself.
    if (parent.type === "variable_declarator") {
      const nameField = parent.childForFieldName
        ? parent.childForFieldName("name")
        : null;
      return sameNode(nameField, node);
    }
    return true;
  }
  // Walk upward ONLY through pattern intermediate nodes (destructuring).
  // Skipping through arbitrary expressions misidentifies every identifier
  // inside an initializer as a declaration of itself.
  if (!PATTERN_INTERMEDIATE_TYPES.has(parent.type)) return false;
  let up: Parser.SyntaxNode | null = parent.parent;
  while (up && PATTERN_INTERMEDIATE_TYPES.has(up.type)) up = up.parent;
  if (up === null || !set.has(up.type)) return false;
  // If we walked through patterns to a variable_declarator, confirm we came
  // from the `name` field (left side) not `value` (right side). Compare by
  // byte-range containment since refs aren't stable.
  if (up.type === "variable_declarator") {
    const nameField = up.childForFieldName
      ? up.childForFieldName("name")
      : null;
    if (!nameField) return false;
    // node lies inside nameField iff [node.start, node.end] ⊆ [nameField.start, nameField.end].
    return (
      node.startIndex >= nameField.startIndex &&
      node.endIndex <= nameField.endIndex
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Range edit applicator
// ---------------------------------------------------------------------------

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
// Identifier validation
// ---------------------------------------------------------------------------

/**
 * JS/TS identifier syntax check.
 *
 * Uses the ECMAScript ID_Start / ID_Continue Unicode sets (ES2018+ `/\p{}/u`
 * regex) so identifiers like `café`, `π`, `日本語` are accepted. ZWNJ (U+200C)
 * and ZWJ (U+200D) are allowed in continue position per spec.
 *
 * Tree-sitter TS/TSX/JS grammars all tokenize Unicode identifiers correctly
 * (verified — a `const café = 1` source parses as `identifier` node with
 * text "café"), so a rename plan produced here applies cleanly.
 */
export function validateIdentifier(name: string): string | null {
  if (!name) return "new name is empty";
  // ES identifier: first char is ID_Start | _ | $; rest is ID_Continue | _ | $
  // | ZWNJ (U+200C) | ZWJ (U+200D).
  if (!/^[\p{ID_Start}_$][\p{ID_Continue}_$‌‍]*$/u.test(name)) {
    return `'${name}' is not a valid JS identifier (must start with a letter, '_' or '$' and contain only ID_Continue characters)`;
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

// ---------------------------------------------------------------------------
// rangesToNodes — range-to-node round-trip (used by file-local rename)
// ---------------------------------------------------------------------------

/**
 * Resolve a list of [start, end] ranges back to concrete tree nodes by
 * re-walking the tree. Inefficient (O(nodes) per plan) — deferred to v1.14
 * when `extractIdentifiers` returns SyntaxNode refs alongside the
 * {name, kind, range} tuples, making the round-trip walk unnecessary.
 */
export function rangesToNodes(tree: Parser.Tree, ranges: Array<[number, number]>): Parser.SyntaxNode[] {
  const wanted = new Set(ranges.map((r) => `${r[0]}:${r[1]}`));
  const out: Parser.SyntaxNode[] = [];
  walkNodes(tree, (n) => {
    if (wanted.has(`${n.startIndex}:${n.endIndex}`)) out.push(n);
  });
  return out;
}
