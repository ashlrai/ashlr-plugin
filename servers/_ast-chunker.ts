/**
 * _ast-chunker.ts — Symbol-level AST chunking for genome indexing (v1.15 prep).
 *
 * Exports:
 *   splitFileIntoChunks — parse a source file and return top-level CodeChunks.
 *   chunkToRagString    — render a CodeChunk as a retrieval-friendly string.
 *
 * MVP scope (v1.14 spike):
 *   - Top-level declarations only: function, class, type alias, interface,
 *     export const/let.
 *   - Per-class chunking is one chunk for the whole class body (per-method
 *     decomposition is a v1.15 expansion).
 *   - Nested functions inside class methods are NOT chunked separately.
 *   - Returns null for unsupported languages (same behaviour as parseFile).
 *
 * Not integrated with ashlr__grep or the genome build pipeline yet — pure
 * export for prototype verification. Integration is v1.15.
 */

import { relative } from "path";
import type Parser from "web-tree-sitter";
import { parseFile } from "./_ast-helpers";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ChunkKind =
  | "function"
  | "class"
  | "type"
  | "interface"
  | "const"
  | "module";

export interface CodeChunk {
  symbol: string;          // "upsertEmbedding"
  kind: ChunkKind;
  signature: string;       // declaration header, body stripped
  docstring: string | null; // leading JSDoc/TSDoc / line-comment block, or null
  file: string;            // relative to cwd
  startLine: number;       // 1-based
  endLine: number;
  startByte: number;
  endByte: number;
}

// ---------------------------------------------------------------------------
// Node types → ChunkKind mapping
// ---------------------------------------------------------------------------

/** Top-level declaration node types we chunk. */
const DECLARATION_KINDS: Record<string, ChunkKind> = {
  function_declaration: "function",
  class_declaration:    "class",
  type_alias_declaration: "type",
  interface_declaration:  "interface",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse `filePath` and return one CodeChunk per top-level declaration.
 *
 * Returns `null` for unsupported languages (mirrors parseFile behaviour).
 * Returns an empty array for a parseable but empty file.
 */
export async function splitFileIntoChunks(
  filePath: string,
): Promise<CodeChunk[] | null> {
  const parsed = await parseFile(filePath);
  if (!parsed) return null;

  const { tree, source } = parsed;
  const relPath = relative(process.cwd(), filePath);
  const chunks: CodeChunk[] = [];

  const root = tree.rootNode;

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)!;
    const chunk = tryExtractChunk(node, source, relPath);
    if (chunk) chunks.push(chunk);
  }

  return chunks;
}

/**
 * Render a CodeChunk as a compact retrieval string.
 *
 * Format:
 *   # {file}:{startLine}-{endLine} · {kind} · {symbol}
 *   {docstring}          ← omitted if null
 *   {signature}
 *
 * Full body is intentionally omitted; callers can expand on demand.
 */
export function chunkToRagString(chunk: CodeChunk): string {
  const header = `# ${chunk.file}:${chunk.startLine}-${chunk.endLine} · ${chunk.kind} · ${chunk.symbol}`;
  const parts: string[] = [header];
  if (chunk.docstring) parts.push(chunk.docstring);
  parts.push(chunk.signature);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to build a CodeChunk from a single syntax node.
 * Returns null if the node is not a top-level declaration we care about.
 */
function tryExtractChunk(
  node: Parser.SyntaxNode,
  source: string,
  relPath: string,
): CodeChunk | null {
  const type = node.type;

  // Named declarations -------------------------------------------------------
  const declKind = DECLARATION_KINDS[type];
  if (declKind !== undefined) {
    const symbol = extractName(node);
    if (!symbol) return null;
    return buildChunk(node, source, relPath, symbol, declKind);
  }

  // export_statement wrapping a declaration or variable statement ------------
  if (type === "export_statement") {
    return tryExtractFromExport(node, source, relPath);
  }

  return null;
}

/**
 * Handle `export_statement` nodes. We recognise:
 *   export function foo() {}
 *   export class Foo {}
 *   export type Foo = …
 *   export interface Foo {}
 *   export const X = …
 *   export let X = …
 */
function tryExtractFromExport(
  exportNode: Parser.SyntaxNode,
  source: string,
  relPath: string,
): CodeChunk | null {
  // The exported declaration is always the last named child of export_statement.
  const decl = exportNode.namedChildren.find(
    (c) =>
      DECLARATION_KINDS[c.type] !== undefined ||
      c.type === "lexical_declaration" ||
      c.type === "variable_declaration",
  );
  if (!decl) return null;

  const declKind = DECLARATION_KINDS[decl.type];
  if (declKind !== undefined) {
    const symbol = extractName(decl);
    if (!symbol) return null;
    // Use the export node for byte/line extents so the export keyword is included.
    return buildChunk(exportNode, source, relPath, symbol, declKind);
  }

  // lexical_declaration / variable_declaration → const/let X = …
  if (
    decl.type === "lexical_declaration" ||
    decl.type === "variable_declaration"
  ) {
    return tryExtractFromLexicalDecl(exportNode, decl, source, relPath);
  }

  return null;
}

/**
 * Extract a "const" chunk from `export const X = …` or `export let X = …`.
 * Only the first declarator is used as the chunk name; multi-declarator
 * destructuring exports are skipped (uncommon in library code).
 */
function tryExtractFromLexicalDecl(
  exportNode: Parser.SyntaxNode,
  decl: Parser.SyntaxNode,
  source: string,
  relPath: string,
): CodeChunk | null {
  const declarator = decl.namedChildren.find(
    (c) => c.type === "variable_declarator",
  );
  if (!declarator) return null;

  const nameNode = declarator.namedChildren.find(
    (c) => c.type === "identifier",
  );
  if (!nameNode) return null;

  const symbol = nameNode.text;
  return buildChunk(exportNode, source, relPath, symbol, "const");
}

/**
 * Build a CodeChunk from a node + metadata.
 */
function buildChunk(
  node: Parser.SyntaxNode,
  source: string,
  relPath: string,
  symbol: string,
  kind: ChunkKind,
): CodeChunk {
  const docstring = extractDocstring(node, source);
  const signature = extractSignature(node, source, kind);

  return {
    symbol,
    kind,
    signature,
    docstring,
    file: relPath,
    startLine: node.startPosition.row + 1,   // tree-sitter rows are 0-based
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
  };
}

/**
 * Return the name identifier text from a declaration node.
 *
 * Works for: function_declaration, class_declaration,
 * type_alias_declaration, interface_declaration.
 */
function extractName(node: Parser.SyntaxNode): string | null {
  // tree-sitter names the name child "name" for all four node types.
  const nameNode = node.childForFieldName?.("name") ??
    node.namedChildren.find(
      (c) => c.type === "identifier" || c.type === "type_identifier",
    );
  return nameNode?.text ?? null;
}

/**
 * Extract the declaration signature — the header line(s) with the body
 * (statement_block / class_body / object_type / ...) stripped.
 *
 * Strategy: take the full node text, locate the opening `{` of the body
 * (or `=` for type aliases), and trim everything from there onward.
 * Falls back to the first source line of the node.
 */
function extractSignature(
  node: Parser.SyntaxNode,
  source: string,
  kind: ChunkKind,
): string {
  const nodeText = source.slice(node.startIndex, node.endIndex);

  // For type aliases: `type Foo = Bar` — strip everything after `=`.
  // We keep the `= TypeExpression` for readability but drop multiline bodies.
  if (kind === "type") {
    // Replace a multi-line type body with a single-line placeholder.
    const firstLine = nodeText.split("\n")[0]!.trimEnd();
    // If the full type fits on one line, return as-is (no trailing semicolon stripping).
    if (!nodeText.includes("\n")) return nodeText.trim();
    return firstLine + " …";
  }

  // For everything else: find the opening brace of the body and truncate.
  // We walk children to find the block/body node rather than doing naive
  // string-scanning, which would break on `{` inside generics.
  const bodyNode = findBodyNode(node, kind);
  if (bodyNode) {
    const headerEnd = bodyNode.startIndex - node.startIndex;
    return nodeText.slice(0, headerEnd).trimEnd();
  }

  // Fallback: first line of the node text.
  return nodeText.split("\n")[0]!.trimEnd();
}

/**
 * Locate the "body" child node for a given declaration kind.
 * Returns null if not found.
 */
function findBodyNode(
  node: Parser.SyntaxNode,
  kind: ChunkKind,
): Parser.SyntaxNode | null {
  const bodyTypes = new Set([
    "statement_block",   // function body
    "class_body",        // class body
    "object_type",       // interface body in TS
    "type_parameters",   // not a body, skip — handled separately
  ]);

  // For interfaces, tree-sitter uses `object_type` as the body.
  // For classes, `class_body`. For functions, `statement_block`.
  for (const child of node.namedChildren) {
    if (bodyTypes.has(child.type) && child.type !== "type_parameters") {
      return child;
    }
  }

  // For export_statement wrapping, drill one level in.
  if (node.type === "export_statement") {
    for (const child of node.namedChildren) {
      const inner = findBodyNode(child, kind);
      if (inner) return inner;
    }
  }

  return null;
}

/**
 * Extract a JSDoc/TSDoc block or contiguous line-comment block that
 * immediately precedes `node` in the source.
 *
 * Looks at the previous named siblings and collects contiguous `comment`
 * nodes working backward (stopping at any non-comment node or a gap in lines).
 */
function extractDocstring(
  node: Parser.SyntaxNode,
  source: string,
): string | null {
  const comments: string[] = [];
  let prev = previousNamedSibling(node);
  // Reference node for adjacency: starts as the declaration, then becomes
  // the previously collected comment as we walk further back.
  let reference: Parser.SyntaxNode = node;

  // Collect contiguous comment nodes immediately before this declaration.
  while (prev && prev.type === "comment") {
    // Ensure the comment is adjacent (no blank line gap) to the reference below it.
    if (!isAdjacentAbove(prev, reference, source)) break;
    comments.unshift(source.slice(prev.startIndex, prev.endIndex));
    reference = prev;
    prev = previousNamedSibling(prev);
  }

  if (comments.length === 0) return null;
  return comments.join("\n");
}

/**
 * Walk `node.parent.namedChildren` to find the sibling immediately before node.
 * SyntaxNode.previousNamedSibling exists in web-tree-sitter but the typing is
 * sometimes absent in older @types stubs — access via cast to be safe.
 */
function previousNamedSibling(
  node: Parser.SyntaxNode,
): Parser.SyntaxNode | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prev = (node as any).previousNamedSibling;
  return prev ?? null;
}

/**
 * Returns true if `commentNode` ends on the line immediately before
 * `declNode` starts (no blank lines between them).
 */
function isAdjacentAbove(
  commentNode: Parser.SyntaxNode,
  declNode: Parser.SyntaxNode,
  _source: string,
): boolean {
  const commentEndLine = commentNode.endPosition.row;
  const declStartLine = declNode.startPosition.row;
  return declStartLine - commentEndLine <= 1;
}
