/**
 * _ast-skeleton.ts — AST-truncated skeleton renderer for ashlr__read.
 *
 * For large wired-language files (TS/TSX/JS), instead of snipCompact head+tail
 * truncation we return a SKELETON: import/export-from lines verbatim at the top,
 * followed by every top-level symbol's docstring + signature + a one-line body
 * elision marker.  Typical savings: 60–80% vs full source.
 *
 * Contract:
 *   - Returns null on ANY failure — callers MUST fall through to snipCompact.
 *   - Never throws.
 *   - Deterministic (no Date.now / Math.random).
 */

import { resolveLanguage } from "./_ast-languages";
import { splitFileIntoChunks } from "./_ast-chunker";

/** Languages fully wired for AST skeleton rendering. */
const WIRED_SKELETON_LANGUAGES = new Set(["typescript", "tsx", "javascript"]);

/** Regex that matches import / export-from / re-export lines. */
const IMPORT_EXPORT_RE =
  /^\s*(import\b|export\s+(?:\*|\{|type\b).*\bfrom\b|export\s+\{)/;

/**
 * Render an AST skeleton for `filePath`.
 *
 * Returns null when:
 *   - Language is not in the wired JS/TS set.
 *   - splitFileIntoChunks returns null or an empty array.
 *   - Any unexpected error occurs.
 */
export async function renderAstSkeleton(
  filePath: string,
  content: string,
): Promise<string | null> {
  try {
    // Guard: only wired languages get AST treatment.
    const lang = resolveLanguage(filePath);
    if (!lang || !WIRED_SKELETON_LANGUAGES.has(lang)) return null;

    // Parse the file into top-level chunks.
    const chunks = await splitFileIntoChunks(filePath);
    if (!chunks || chunks.length === 0) return null;

    // -----------------------------------------------------------------------
    // Extract import / export-from lines via line scan (no AST needed — these
    // are always verbatim and the regex is reliable for TS/JS).
    // -----------------------------------------------------------------------
    const importLines: string[] = [];
    for (const line of content.split("\n")) {
      if (IMPORT_EXPORT_RE.test(line)) {
        importLines.push(line);
      }
    }

    // -----------------------------------------------------------------------
    // Build the skeleton body: one block per chunk in source order.
    // -----------------------------------------------------------------------
    const parts: string[] = [];

    // Import block at the top (if any).
    if (importLines.length > 0) {
      parts.push(importLines.join("\n"));
      parts.push(""); // blank separator
    }

    // One block per chunk, preserving source order (splitFileIntoChunks already
    // returns chunks in tree-sitter traversal = source order).
    for (const chunk of chunks) {
      const block: string[] = [];
      if (chunk.docstring) {
        block.push(chunk.docstring);
      }
      block.push(chunk.signature);
      block.push(
        `  // … body elided (L${chunk.startLine}–L${chunk.endLine})`,
      );
      parts.push(block.join("\n"));
    }

    // -----------------------------------------------------------------------
    // Footer note so agents know how to recover the full file.
    // -----------------------------------------------------------------------
    parts.push(
      "\n// [ast-skeleton] Signatures only — bodies elided for token efficiency." +
        "\n// To read the full file: pass bypassSummary:true to ashlr__read.",
    );

    return parts.join("\n\n");
  } catch {
    // Tree-sitter can timeout on macOS cold-start; any other error also falls back.
    return null;
  }
}
