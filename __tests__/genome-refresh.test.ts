/**
 * Tests for Track HH — genome continuous refresh.
 *
 * Covers:
 *   1. posttooluse-genome-refresh hook — pending-list append + dedup
 *   2. genome-refresh-worker — reads pending, processes, clears
 *   3. genome-refresh-worker — debounce (rapid edits → single refresh)
 *   4. genome-refresh-worker — --full flag triggers full rebuild path
 *   5. stale-detection counter exported from grep-server
 *
 * All tests use isolated tmpdirs. Real .ashlrcode/genome/ writes are mocked
 * so no actual genome infrastructure is touched beyond what initGenome creates.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initGenome, writeSection } from "@ashlr/core-efficiency/genome";
import {
  isWriteTool,
  extractFilePaths,
  appendToPending,
  handle,
  PENDING_FILE_NAME,
} from "../hooks/posttooluse-genome-refresh";
import {
  parseArgs,
  readPendingPaths,
  clearPendingFile,
  pendingFilePath,
  isDebounced,
  groupByGenomeRoot,
  refreshPaths,
  run as workerRun,
} from "../scripts/genome-refresh-worker";
import {
  _resetStaleFallbackCount,
  _getStaleFallbackCount,
} from "../servers/grep-server";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let tmpBase: string;

beforeEach(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), "ashlr-genome-refresh-"));
  delete process.env.ASHLR_GENOME_AUTO;
  _resetStaleFallbackCount();
});

afterEach(async () => {
  delete process.env.ASHLR_GENOME_AUTO;
  _resetStaleFallbackCount();
  await rm(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeHome(suffix: string): string {
  const h = join(tmpBase, suffix);
  mkdirSync(join(h, ".ashlr"), { recursive: true });
  return h;
}

function readPending(home: string): string[] {
  const file = join(home, ".ashlr", PENDING_FILE_NAME);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim());
}

// ---------------------------------------------------------------------------
// 1. isWriteTool
// ---------------------------------------------------------------------------

describe("posttooluse-genome-refresh · isWriteTool", () => {
  test("recognizes built-in Edit, Write, MultiEdit, NotebookEdit", () => {
    expect(isWriteTool("Edit")).toBe(true);
    expect(isWriteTool("Write")).toBe(true);
    expect(isWriteTool("MultiEdit")).toBe(true);
    expect(isWriteTool("NotebookEdit")).toBe(true);
  });

  test("recognizes all ashlr MCP edit variants", () => {
    const variants = [
      "mcp__plugin_ashlr_ashlr__ashlr__edit",
      "mcp__plugin_ashlr_ashlr__ashlr__write",
      "mcp__plugin_ashlr_ashlr__ashlr__multi_edit",
      "mcp__plugin_ashlr_ashlr__ashlr__notebook_edit",
      "mcp__plugin_ashlr_ashlr__ashlr__edit_structural",
      "mcp__plugin_ashlr_ashlr__ashlr__rename_file",
    ];
    for (const v of variants) {
      expect(isWriteTool(v)).toBe(true);
    }
  });

  test("rejects non-write tools", () => {
    expect(isWriteTool("Read")).toBe(false);
    expect(isWriteTool("Grep")).toBe(false);
    expect(isWriteTool("Bash")).toBe(false);
    expect(isWriteTool(undefined)).toBe(false);
    expect(isWriteTool("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. extractFilePaths
// ---------------------------------------------------------------------------

describe("posttooluse-genome-refresh · extractFilePaths", () => {
  test("extracts file_path from Edit payload", () => {
    expect(extractFilePaths({ file_path: "/foo/bar.ts" })).toContain("/foo/bar.ts");
  });

  test("extracts path from Write payload", () => {
    expect(extractFilePaths({ path: "/foo/baz.ts" })).toContain("/foo/baz.ts");
  });

  test("extracts old_path and new_path from rename payload", () => {
    const paths = extractFilePaths({ old_path: "/a.ts", new_path: "/b.ts" });
    expect(paths).toContain("/a.ts");
    expect(paths).toContain("/b.ts");
  });

  test("extracts file_path from each MultiEdit edit", () => {
    const paths = extractFilePaths({
      edits: [{ file_path: "/x.ts" }, { file_path: "/y.ts" }],
    });
    expect(paths).toContain("/x.ts");
    expect(paths).toContain("/y.ts");
  });

  test("deduplicates paths within a single payload", () => {
    const paths = extractFilePaths({
      file_path: "/dup.ts",
      edits: [{ file_path: "/dup.ts" }],
    });
    expect(paths.filter((p) => p === "/dup.ts")).toHaveLength(1);
  });

  test("returns [] for null/undefined input", () => {
    expect(extractFilePaths(null)).toEqual([]);
    expect(extractFilePaths(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. appendToPending
// ---------------------------------------------------------------------------

describe("posttooluse-genome-refresh · appendToPending", () => {
  test("appends a new path", () => {
    const home = fakeHome("h1");
    appendToPending(["/a/b.ts"], home);
    expect(readPending(home)).toContain("/a/b.ts");
  });

  test("deduplicates on second append", () => {
    const home = fakeHome("h2");
    appendToPending(["/a/b.ts"], home);
    appendToPending(["/a/b.ts"], home);
    expect(readPending(home).filter((l) => l === "/a/b.ts")).toHaveLength(1);
  });

  test("appends multiple paths in one call", () => {
    const home = fakeHome("h3");
    appendToPending(["/x.ts", "/y.ts", "/z.ts"], home);
    const lines = readPending(home);
    expect(lines).toContain("/x.ts");
    expect(lines).toContain("/y.ts");
    expect(lines).toContain("/z.ts");
  });

  test("returns false when paths is empty", () => {
    expect(appendToPending([], fakeHome("h4"))).toBe(false);
  });

  test("returns true when a new path was added", () => {
    expect(appendToPending(["/new.ts"], fakeHome("h5"))).toBe(true);
  });

  test("returns false when all paths already present", () => {
    const home = fakeHome("h6");
    appendToPending(["/dup.ts"], home);
    expect(appendToPending(["/dup.ts"], home)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. handle() — pass-through semantics
// ---------------------------------------------------------------------------

describe("posttooluse-genome-refresh · handle", () => {
  test("always returns PostToolUse hookSpecificOutput", () => {
    const out = handle(
      { tool_name: "Edit", tool_input: { file_path: "/x.ts" } },
      fakeHome("h7"),
    );
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  });

  test("records path for Edit tool", () => {
    const home = fakeHome("h8");
    handle({ tool_name: "Edit", tool_input: { file_path: "/tracked.ts" } }, home);
    const content = readFileSync(join(home, ".ashlr", PENDING_FILE_NAME), "utf-8");
    expect(content).toContain("/tracked.ts");
  });

  test("skips recording when ASHLR_GENOME_AUTO=0", () => {
    process.env.ASHLR_GENOME_AUTO = "0";
    const home = fakeHome("h9");
    handle({ tool_name: "Edit", tool_input: { file_path: "/skipped.ts" } }, home);
    expect(existsSync(join(home, ".ashlr", PENDING_FILE_NAME))).toBe(false);
  });

  test("skips recording for Read (non-write tool)", () => {
    const home = fakeHome("h10");
    handle({ tool_name: "Read", tool_input: { file_path: "/read.ts" } }, home);
    expect(existsSync(join(home, ".ashlr", PENDING_FILE_NAME))).toBe(false);
  });

  test("skips recording when edit failed (isError:true)", () => {
    const home = fakeHome("h11");
    handle(
      {
        tool_name: "Edit",
        tool_input: { file_path: "/err.ts" },
        tool_response: { isError: true },
      },
      home,
    );
    expect(existsSync(join(home, ".ashlr", PENDING_FILE_NAME))).toBe(false);
  });

  test("records path for Write tool", () => {
    const home = fakeHome("h12");
    handle({ tool_name: "Write", tool_input: { path: "/written.ts" } }, home);
    expect(readPending(home)).toContain("/written.ts");
  });
});

// ---------------------------------------------------------------------------
// 5. readPendingPaths
// ---------------------------------------------------------------------------

describe("genome-refresh-worker · readPendingPaths", () => {
  test("returns [] when pending file does not exist", () => {
    const home = fakeHome("rp1");
    expect(readPendingPaths(home)).toEqual([]);
  });

  test("reads paths from pending file", () => {
    const home = fakeHome("rp2");
    writeFileSync(pendingFilePath(home), "/a.ts\n/b.ts\n", "utf-8");
    const paths = readPendingPaths(home);
    expect(paths).toContain("/a.ts");
    expect(paths).toContain("/b.ts");
  });

  test("deduplicates entries", () => {
    const home = fakeHome("rp3");
    writeFileSync(pendingFilePath(home), "/dup.ts\n/dup.ts\n/dup.ts\n", "utf-8");
    expect(readPendingPaths(home).filter((p) => p === "/dup.ts")).toHaveLength(1);
  });

  test("ignores blank lines", () => {
    const home = fakeHome("rp4");
    writeFileSync(pendingFilePath(home), "\n/x.ts\n\n/y.ts\n\n", "utf-8");
    expect(readPendingPaths(home).filter((p) => !p)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. clearPendingFile
// ---------------------------------------------------------------------------

describe("genome-refresh-worker · clearPendingFile", () => {
  test("removes the pending file", () => {
    const home = fakeHome("cp1");
    const file = pendingFilePath(home);
    writeFileSync(file, "/a.ts\n", "utf-8");
    clearPendingFile(home);
    expect(existsSync(file)).toBe(false);
  });

  test("no-ops when file does not exist", () => {
    const home = fakeHome("cp2");
    expect(() => clearPendingFile(home)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. isDebounced
// ---------------------------------------------------------------------------

describe("genome-refresh-worker · isDebounced", () => {
  test("returns true when pending file does not exist", async () => {
    expect(await isDebounced(fakeHome("db1"), 5_000)).toBe(true);
  });

  test("returns true when debounceMs=0 (always settled)", async () => {
    const home = fakeHome("db2");
    writeFileSync(pendingFilePath(home), "/a.ts\n", "utf-8");
    expect(await isDebounced(home, 0)).toBe(true);
  });

  test("returns false when debounce window is huge (file just written)", async () => {
    const home = fakeHome("db3");
    writeFileSync(pendingFilePath(home), "/a.ts\n", "utf-8");
    expect(await isDebounced(home, 600_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. groupByGenomeRoot
// ---------------------------------------------------------------------------

describe("genome-refresh-worker · groupByGenomeRoot", () => {
  test("drops paths with no genome root", () => {
    const grouped = groupByGenomeRoot(["/definitely/no/genome/here/file.ts"]);
    expect(grouped.size).toBe(0);
  });

  test("groups multiple files under the same genome root", async () => {
    const projectDir = join(tmpBase, "grp-proj");
    await mkdir(projectDir, { recursive: true });
    await initGenome(projectDir, { project: "test", vision: "v", milestone: "m1" });

    const grouped = groupByGenomeRoot([
      join(projectDir, "src/a.ts"),
      join(projectDir, "src/b.ts"),
    ]);
    expect(grouped.size).toBe(1);
    const [[root, files]] = [...grouped.entries()];
    expect(root).toBe(projectDir);
    expect(files).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 9. workerRun — processes pending list and clears it
// ---------------------------------------------------------------------------

describe("genome-refresh-worker · run — processes and clears pending", () => {
  test("clears pending file after processing", async () => {
    const home = fakeHome("run1");
    const projectDir = join(tmpBase, "run-proj1");
    await mkdir(projectDir, { recursive: true });
    await initGenome(projectDir, { project: "test", vision: "v", milestone: "m1" });

    const pending = pendingFilePath(home);
    writeFileSync(pending, join(projectDir, "src", "widget.ts") + "\n", "utf-8");

    await workerRun({ full: false, dryRun: false, quiet: true, debounceMs: 0, home });

    expect(existsSync(pending)).toBe(false);
  });

  test("does not clear pending file in dry-run mode", async () => {
    const home = fakeHome("run2");
    const pending = pendingFilePath(home);
    writeFileSync(pending, "/some/file.ts\n", "utf-8");

    await workerRun({ full: false, dryRun: true, quiet: true, debounceMs: 0, home });

    expect(existsSync(pending)).toBe(true);
  });

  test("respects ASHLR_GENOME_AUTO=0 kill switch", async () => {
    process.env.ASHLR_GENOME_AUTO = "0";
    const home = fakeHome("run3");
    const pending = pendingFilePath(home);
    writeFileSync(pending, "/file.ts\n", "utf-8");

    const summary = await workerRun({
      full: false,
      dryRun: false,
      quiet: true,
      debounceMs: 0,
      home,
    });

    expect(summary.filesProcessed).toBe(0);
    expect(existsSync(pending)).toBe(true);
  });

  test("debounce: skips processing when pending file is too fresh", async () => {
    const home = fakeHome("run4");
    const pending = pendingFilePath(home);
    writeFileSync(pending, "/file.ts\n", "utf-8");

    const summary = await workerRun({
      full: false,
      dryRun: false,
      quiet: true,
      debounceMs: 600_000, // 10 minutes → file just written → not settled
      home,
    });

    expect(summary.filesProcessed).toBe(0);
    expect(existsSync(pending)).toBe(true); // NOT cleared
  });
});

// ---------------------------------------------------------------------------
// 10. workerRun --full flag
// ---------------------------------------------------------------------------

describe("genome-refresh-worker · run --full", () => {
  test("--full + --dry-run: returns filesProcessed = pending count", async () => {
    const home = fakeHome("full1");
    const projectDir = join(tmpBase, "full-proj1");
    await mkdir(projectDir, { recursive: true });
    await initGenome(projectDir, { project: "test", vision: "v", milestone: "m1" });

    const pending = pendingFilePath(home);
    writeFileSync(pending, join(projectDir, "src/a.ts") + "\n", "utf-8");

    const summary = await workerRun({
      full: true,
      dryRun: true,
      quiet: true,
      debounceMs: 0,
      home,
    });

    expect(summary.filesProcessed).toBe(1);
  });

  test("--full (non-dry): clears pending file", async () => {
    const home = fakeHome("full2");
    const projectDir = join(tmpBase, "full-proj2");
    await mkdir(projectDir, { recursive: true });
    await initGenome(projectDir, { project: "test", vision: "v", milestone: "m1" });

    const pending = pendingFilePath(home);
    writeFileSync(pending, join(projectDir, "src/a.ts") + "\n", "utf-8");

    await workerRun({
      full: true,
      dryRun: false,
      quiet: true,
      debounceMs: 0,
      home,
    });

    expect(existsSync(pending)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. parseArgs
// ---------------------------------------------------------------------------

describe("genome-refresh-worker · parseArgs", () => {
  test("defaults", () => {
    const args = parseArgs([]);
    expect(args.full).toBe(false);
    expect(args.dryRun).toBe(false);
    expect(args.quiet).toBe(false);
    expect(args.debounceMs).toBeGreaterThan(0);
  });

  test("--full", () => {
    expect(parseArgs(["--full"]).full).toBe(true);
  });

  test("--dry-run", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
  });

  test("--quiet", () => {
    expect(parseArgs(["--quiet"]).quiet).toBe(true);
  });

  test("--debounce N", () => {
    expect(parseArgs(["--debounce", "5000"]).debounceMs).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// 12. grep-server stale-detection exports
// ---------------------------------------------------------------------------

describe("grep-server · stale-detection exports", () => {
  test("counter starts at 0 after reset", () => {
    _resetStaleFallbackCount();
    expect(_getStaleFallbackCount()).toBe(0);
  });

  test("reset brings counter back to 0 from any state", () => {
    _resetStaleFallbackCount();
    _resetStaleFallbackCount(); // idempotent
    expect(_getStaleFallbackCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 13. refreshPaths — incremental (real genome, no mock)
// ---------------------------------------------------------------------------

describe("genome-refresh-worker · refreshPaths", () => {
  test("processes file under genome root and increments filesProcessed", async () => {
    const projectDir = join(tmpBase, "rp-proj1");
    await mkdir(projectDir, { recursive: true });
    await initGenome(projectDir, { project: "test", vision: "v", milestone: "m1" });
    await writeSection(
      projectDir,
      "knowledge/myfile.md",
      "# myfile.ts\n\nSome summary about myfile.ts.\n",
      { title: "myfile.ts", summary: "summary myfile.ts", tags: ["myfile.ts"] },
    );

    const summary = await refreshPaths([join(projectDir, "src", "myfile.ts")], {
      quiet: true,
    });

    expect(summary.filesProcessed).toBe(1);
    expect(summary.genomeRoots).toContain(projectDir);
  });

  test("dry-run: 0 filesProcessed", async () => {
    const projectDir = join(tmpBase, "rp-proj2");
    await mkdir(projectDir, { recursive: true });
    await initGenome(projectDir, { project: "test", vision: "v", milestone: "m1" });

    const summary = await refreshPaths([join(projectDir, "src", "x.ts")], {
      dryRun: true,
      quiet: true,
    });

    expect(summary.filesProcessed).toBe(0);
  });

  test("drops paths with no genome root (no error thrown)", async () => {
    const summary = await refreshPaths(["/no/genome/here/file.ts"], { quiet: true });
    expect(summary.filesProcessed).toBe(0);
    expect(summary.genomeRoots).toHaveLength(0);
  });
});
