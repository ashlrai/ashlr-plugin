/**
 * notebook-edit-server — ashlr__notebook_edit tool implementation.
 *
 * Edits a single cell in a Jupyter notebook (.ipynb) and returns a
 * compressed response that includes only the edited cell and its immediate
 * neighbors. The full notebook is never echoed back — only a surroundingCells
 * window of 3 entries (above, edited, below).
 *
 * Savings baseline: raw = full notebook JSON bytes; compact = response JSON bytes.
 */

import { readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { recordSaving } from "./_stats";
import { clampToCwd } from "./_cwd-clamp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotebookEditArgs {
  notebookPath: string;
  cellIndex: number;
  newSource: string;
  cellType?: "code" | "markdown";
}

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface NotebookJson {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

interface SurroundingCell {
  index: number;
  type: string;
  sourcePreview: string;
}

export interface NotebookEditResult {
  notebookPath: string;
  editedCellIndex: number;
  totalCells: number;
  unchangedCellCount: number;
  surroundingCells: SurroundingCell[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PREVIEW_MAX = 120;

/** Truncate a cell source string for preview output. */
function previewSource(source: string | string[]): string {
  const flat = Array.isArray(source) ? source.join("") : source;
  if (flat.length <= PREVIEW_MAX) return flat;
  return flat.slice(0, PREVIEW_MAX) + `… (${flat.length - PREVIEW_MAX} more chars)`;
}

/** Normalize cell source to string. Jupyter stores source as string or string[]. */
function flattenSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source;
}

/**
 * Store new source back in the notebook cell, preserving the original format
 * (array or string). Most tooling writes arrays; we match the original style.
 */
function encodeSource(newSource: string, originalCell: NotebookCell): string | string[] {
  if (Array.isArray(originalCell.source)) {
    // Split on newlines, keep trailing newline chars on each line except last.
    const lines = newSource.split("\n");
    return lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line));
  }
  return newSource;
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

export async function ashlrNotebookEdit(input: NotebookEditArgs): Promise<NotebookEditResult> {
  const { notebookPath, cellIndex, newSource, cellType } = input;

  const clamp = clampToCwd(notebookPath, "ashlr__notebook_edit");
  if (!clamp.ok) throw new Error(clamp.message);
  const abs = clamp.abs;

  const raw = await readFile(abs, "utf-8");
  const rawBytes = raw.length;

  let nb: NotebookJson;
  try {
    nb = JSON.parse(raw) as NotebookJson;
  } catch {
    throw new Error(`ashlr__notebook_edit: failed to parse notebook JSON at ${notebookPath}`);
  }

  if (!Array.isArray(nb.cells)) {
    throw new Error(`ashlr__notebook_edit: notebook has no 'cells' array: ${notebookPath}`);
  }

  const totalCells = nb.cells.length;

  if (cellIndex < 0 || cellIndex >= totalCells) {
    throw new Error(
      `ashlr__notebook_edit: cellIndex ${cellIndex} out of range (notebook has ${totalCells} cells)`,
    );
  }

  const cell = nb.cells[cellIndex]!;

  // Apply the edit — direct array assignment (no applyRangeEdits abstraction
  // needed; cell-content edits are a full-cell replacement, not a char-level
  // range operation).
  cell.source = encodeSource(newSource, cell);
  if (cellType) {
    cell.cell_type = cellType;
    // Markdown cells don't carry outputs or execution_count.
    if (cellType === "markdown") {
      delete cell.outputs;
      delete cell.execution_count;
    }
  }

  const updated = JSON.stringify(nb, null, 1);
  await writeFile(abs, updated, "utf-8");

  // Build surroundingCells: edited cell + 1 above + 1 below.
  const surroundingCells: SurroundingCell[] = [];
  const indices = [cellIndex - 1, cellIndex, cellIndex + 1].filter(
    (i) => i >= 0 && i < totalCells,
  );
  for (const idx of indices) {
    const c = nb.cells[idx]!;
    surroundingCells.push({
      index: idx,
      type: c.cell_type,
      sourcePreview: previewSource(c.source),
    });
  }

  const result: NotebookEditResult = {
    notebookPath: abs,
    editedCellIndex: cellIndex,
    totalCells,
    unchangedCellCount: totalCells - 1,
    surroundingCells,
  };

  const compactBytes = JSON.stringify(result).length;
  await recordSaving(rawBytes, compactBytes, "ashlr__notebook_edit");

  return result;
}

/**
 * Format the result as a human-readable text response for the MCP tool.
 */
export function formatNotebookEditResult(result: NotebookEditResult): string {
  const lines: string[] = [
    `[ashlr__notebook_edit] ${result.notebookPath}`,
    `  edited cell ${result.editedCellIndex} of ${result.totalCells} (${result.unchangedCellCount} unchanged cells elided)`,
    `  surrounding cells:`,
  ];
  for (const cell of result.surroundingCells) {
    const marker = cell.index === result.editedCellIndex ? " ← edited" : "";
    lines.push(`    [${cell.index}] ${cell.type}${marker}: ${cell.sourcePreview.replace(/\n/g, "↵")}`);
  }
  return lines.join("\n");
}
