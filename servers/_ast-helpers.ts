/**
 * _ast-helpers.ts — Tree-sitter parse utilities for AST-aware editing (Track C, Sprint 1).
 *
 * Exports:
 *   parseFile        — read + parse a source file, return tree/source/lang tuple.
 *   extractIdentifiers — walk a parsed tree, return all identifiers with kind.
 *   walkNodes        — generic depth-first tree walker.
 *
 * Value vs type identifier distinction (TypeScript):
 *   tree-sitter-typescript uses two distinct node types for identifiers:
 *     - `identifier`      — value-positioned names (variables, functions, classes in
 *                           expressions, parameter names, etc.)
 *     - `type_identifier` — type-positioned names (type annotations, type aliases,
 *                           interface names, generic params, etc.)
 *   `property_identifier` is also captured as "value" (object property names).
 *
 *   Conservative heuristics sufficient for sprint-1. Sprint-2 adds scope-aware
 *   resolution (shadowing, closures, re-exports).
 */

import { readFile } from "fs/promises";
// web-tree-sitter@0.22.x: default export is Parser; Tree/SyntaxNode live in the
// Parser namespace. Import only types to avoid circular init.
import type Parser from "web-tree-sitter";
import { resolveLanguage, getParser, type Language, type WTSParser } from "./_ast-languages";

// Re-export Language for convenience.
export type { Language };

// Convenience aliases for the 0.22.x namespace types.
type Tree = Parser.Tree;
type SyntaxNode = Parser.SyntaxNode;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParseResult {
  tree: Tree;
  source: string;
  lang: Language;
}

export interface IdentifierRef {
  /** The raw text of the identifier node. */
  name: string;
  /**
   * `"value"` — identifier appears in a value/expression position.
   * `"type"`  — identifier appears in a type annotation or type-level position.
   */
  kind: "value" | "type";
  /**
   * [startIndex, endIndex] byte offsets into the source string.
   * Use `source.slice(range[0], range[1])` to recover the raw text.
   */
  range: [number, number];
}

// ---------------------------------------------------------------------------
// Node types that carry VALUE-position identifiers across languages
// ---------------------------------------------------------------------------

const VALUE_IDENTIFIER_TYPES = new Set([
  "identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
]);

// ---------------------------------------------------------------------------
// Node types that carry TYPE-position identifiers in TypeScript / TSX
// ---------------------------------------------------------------------------

const TYPE_IDENTIFIER_TYPES = new Set([
  "type_identifier",
]);

// ---------------------------------------------------------------------------
// walkNodes — generic depth-first visitor
// ---------------------------------------------------------------------------

export type NodeVisitor = (node: SyntaxNode) => void;

/**
 * Depth-first pre-order walk of the entire syntax tree.
 * The visitor is called for every node (named and anonymous).
 */
export function walkNodes(tree: Tree, visitor: NodeVisitor): void {
  walkNode(tree.rootNode, visitor);
}

function walkNode(node: SyntaxNode, visitor: NodeVisitor): void {
  visitor(node);
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    walkNode(children[i]!, visitor);
  }
}

// ---------------------------------------------------------------------------
// extractIdentifiers
// ---------------------------------------------------------------------------

/**
 * Walk the tree and collect all identifiers with their kind.
 *
 * Duplicate entries at the same byte range are dropped.
 * A name may appear at multiple distinct ranges (each is a separate entry).
 */
export function extractIdentifiers(
  tree: Tree,
  _source: string
): IdentifierRef[] {
  const results: IdentifierRef[] = [];
  const seen = new Set<string>(); // key: `${startIndex}:${endIndex}`

  walkNodes(tree, (node) => {
    let kind: "value" | "type" | null = null;

    if (VALUE_IDENTIFIER_TYPES.has(node.type)) {
      kind = "value";
    } else if (TYPE_IDENTIFIER_TYPES.has(node.type)) {
      kind = "type";
    }

    if (kind === null) return;

    const key = `${node.startIndex}:${node.endIndex}`;
    if (seen.has(key)) return;
    seen.add(key);

    results.push({
      name: node.text,
      kind,
      range: [node.startIndex, node.endIndex],
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// parseFile
// ---------------------------------------------------------------------------

/**
 * Read and parse a source file.
 *
 * Returns `null` if:
 *   - The file extension is unrecognised.
 *   - The language grammar is not yet wired (Python, Go, Rust in sprint-1).
 *
 * Throws on file-system errors (file not found, permission denied, etc.).
 */
export async function parseFile(filePath: string): Promise<ParseResult | null> {
  const lang = resolveLanguage(filePath);
  if (lang === null) return null;

  // Attempt to get the parser — will throw for unwired languages.
  let parser: WTSParser;
  try {
    parser = await getParser(lang);
  } catch {
    // Unwired language (sprint-2 deliverable): return null gracefully.
    return null;
  }

  const source = await readFile(filePath, "utf-8");
  const tree = parser.parse(source);
  if (!tree) return null;

  return { tree, source, lang };
}
