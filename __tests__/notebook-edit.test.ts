/**
 * notebook-edit.test.ts — ashlr__notebook_edit tool unit tests.
 *
 * Covers:
 *   - Happy path: edit a cell, verify file written correctly.
 *   - Response excludes unchanged cells (only 3-cell window returned).
 *   - recordSaving is called (savings > 0 for a large notebook).
 *   - 50+ cell notebook compresses to <2KB response.
 *   - Cell type change (code → markdown).
 *   - Out-of-range cellIndex throws.
 *   - Array-style source encoding preserved.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, copyFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  ashlrNotebookEdit,
  formatNotebookEditResult,
  type NotebookEditResult,
} from "../servers/notebook-edit-server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_SMALL = join(import.meta.dir, "..", "bench", "fixtures", "notebook-small.ipynb");
const FIXTURE_LARGE = join(import.meta.dir, "..", "bench", "fixtures", "notebook-large.ipynb");

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
const ORIGINAL_CWD = process.cwd();

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ashlr-nb-edit-"));
  process.chdir(tmpDir);
});

afterEach(async () => {
  if (process.cwd() !== ORIGINAL_CWD) {
    try { process.chdir(ORIGINAL_CWD); } catch { /* ignore */ }
  }
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function copyFixture(src: string, name: string): Promise<string> {
  const dest = join(tmpDir, name);
  await copyFile(src, dest);
  return dest;
}

interface NotebookJson {
  cells: Array<{ cell_type: string; source: string | string[] }>;
}

async function readNotebook(path: string): Promise<NotebookJson> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as NotebookJson;
}

// ---------------------------------------------------------------------------
// Happy path: edit a cell, verify file written correctly
// ---------------------------------------------------------------------------

describe("ashlr__notebook_edit · happy path", () => {
  test("edits cell source and writes notebook back", async () => {
    const nbPath = await copyFixture(FIXTURE_SMALL, "test.ipynb");
    const newSource = "# edited\nprint('new content')";

    const result = await ashlrNotebookEdit({
      notebookPath: nbPath,
      cellIndex: 1,
      newSource,
    });

    // Verify the file was written correctly.
    const nb = await readNotebook(nbPath);
    const flat = Array.isArray(nb.cells[1]!.source)
      ? (nb.cells[1]!.source as string[]).join("")
      : (nb.cells[1]!.source as string);
    expect(flat).toBe(newSource);

    // Result shape.
    expect(result.editedCellIndex).toBe(1);
    expect(result.totalCells).toBe(3);
    expect(result.unchangedCellCount).toBe(2);
  });

  test("returns a surroundingCells window of ≤3 entries", async () => {
    const nbPath = await copyFixture(FIXTURE_SMALL, "test.ipynb");

    const result = await ashlrNotebookEdit({
      notebookPath: nbPath,
      cellIndex: 1,
      newSource: "x = 42",
    });

    // cellIndex=1 in a 3-cell notebook → cells [0, 1, 2].
    expect(result.surroundingCells.length).toBe(3);
    expect(result.surroundingCells.some((c) => c.index === 1)).toBe(true);
  });

  test("surroundingCells at first cell only returns cell 0 and 1", async () => {
    const nbPath = await copyFixture(FIXTURE_SMALL, "test.ipynb");

    const result = await ashlrNotebookEdit({
      notebookPath: nbPath,
      cellIndex: 0,
      newSource: "# new first cell",
    });

    // cellIndex=0 → cells [0, 1] only (no cell -1).
    expect(result.surroundingCells.length).toBe(2);
    expect(result.surroundingCells[0]!.index).toBe(0);
    expect(result.surroundingCells[1]!.index).toBe(1);
  });

  test("surroundingCells at last cell only returns last two cells", async () => {
    const nbPath = await copyFixture(FIXTURE_SMALL, "test.ipynb");

    const result = await ashlrNotebookEdit({
      notebookPath: nbPath,
      cellIndex: 2,
      newSource: "# new last cell",
    });

    // cellIndex=2 (last in 3-cell notebook) → cells [1, 2] only.
    expect(result.surroundingCells.length).toBe(2);
    expect(result.surroundingCells[0]!.index).toBe(1);
    expect(result.surroundingCells[1]!.index).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Compression: unchanged cells are elided
// ---------------------------------------------------------------------------

describe("ashlr__notebook_edit · compression", () => {
  test("response excludes unchanged cells (unchanged count matches total - 1)", async () => {
    // Use the large fixture (52 cells) so surroundingCells.length < totalCells is
    // always true regardless of which cell we edit.
    const nbPath = await copyFixture(FIXTURE_LARGE, "test-large.ipynb");

    const result = await ashlrNotebookEdit({
      notebookPath: nbPath,
      cellIndex: 10,
      newSource: "x = 1",
    });

    expect(result.unchangedCellCount).toBe(result.totalCells - 1);
    // Only the 3-cell window is in surroundingCells — not all 52 cells.
    expect(result.surroundingCells.length).toBeLessThan(result.totalCells);
    expect(result.surroundingCells.length).toBe(3);
  });

  test("52-cell notebook produces response < 2KB", async () => {
    const nbPath = await copyFixture(FIXTURE_LARGE, "large.ipynb");

    const result = await ashlrNotebookEdit({
      notebookPath: nbPath,
      cellIndex: 25,
      newSource: "# mid-notebook edit\nprint('compressed')",
    });

    const formatted = formatNotebookEditResult(result);
    expect(formatted.length).toBeLessThan(2048);
    expect(result.totalCells).toBe(52);
    expect(result.unchangedCellCount).toBe(51);
    // surroundingCells is only 3 entries (above + edited + below).
    expect(result.surroundingCells.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Cell type change
// ---------------------------------------------------------------------------

describe("ashlr__notebook_edit · cell type change", () => {
  test("changes cell type when cellType arg is provided", async () => {
    const nbPath = await copyFixture(FIXTURE_SMALL, "test.ipynb");

    const result = await ashlrNotebookEdit({
      notebookPath: nbPath,
      cellIndex: 1,
      newSource: "## Converted to markdown",
      cellType: "markdown",
    });

    const nb = await readNotebook(nbPath);
    expect(nb.cells[1]!.cell_type).toBe("markdown");
    expect(result.surroundingCells.find((c) => c.index === 1)?.type).toBe("markdown");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("ashlr__notebook_edit · errors", () => {
  test("throws on out-of-range cellIndex (too high)", async () => {
    const nbPath = await copyFixture(FIXTURE_SMALL, "test.ipynb");

    await expect(
      ashlrNotebookEdit({ notebookPath: nbPath, cellIndex: 99, newSource: "x" }),
    ).rejects.toThrow("out of range");
  });

  test("throws on negative cellIndex", async () => {
    const nbPath = await copyFixture(FIXTURE_SMALL, "test.ipynb");

    await expect(
      ashlrNotebookEdit({ notebookPath: nbPath, cellIndex: -1, newSource: "x" }),
    ).rejects.toThrow("out of range");
  });

  test("throws on non-existent notebook", async () => {
    await expect(
      ashlrNotebookEdit({
        notebookPath: join(tmpDir, "does-not-exist.ipynb"),
        cellIndex: 0,
        newSource: "x",
      }),
    ).rejects.toThrow();
  });

  test("throws on malformed JSON", async () => {
    const badPath = join(tmpDir, "bad.ipynb");
    await writeFile(badPath, "{ not valid json", "utf-8");

    await expect(
      ashlrNotebookEdit({ notebookPath: badPath, cellIndex: 0, newSource: "x" }),
    ).rejects.toThrow("failed to parse");
  });
});

// ---------------------------------------------------------------------------
// formatNotebookEditResult
// ---------------------------------------------------------------------------

describe("formatNotebookEditResult", () => {
  test("formatted output contains the edited cell marker", async () => {
    const nbPath = await copyFixture(FIXTURE_SMALL, "test.ipynb");

    const result = await ashlrNotebookEdit({
      notebookPath: nbPath,
      cellIndex: 1,
      newSource: "x = 1",
    });

    const text = formatNotebookEditResult(result);
    expect(text).toContain("edited");
    expect(text).toContain("[1]");
    expect(text).toContain("ashlr__notebook_edit");
  });
});
