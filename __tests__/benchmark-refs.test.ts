/**
 * Tests for scripts/benchmark-refs.ts
 *
 * Uses synthetic ref directories (each a git repo with ~5 files) to assert:
 *   - aggregator produces the expected JSON shape
 *   - crossLanguageMean is computed correctly
 *   - byRepo and byLanguage sections are populated
 *   - missing ref directory is skipped gracefully
 *   - dry-run mode does not modify the output file
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

import { runRefsBenchmark } from "../scripts/benchmark-refs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeGitRepo(dirName: string, files: Array<{ name: string; size: number }>): string {
  const dir = join(tmpDir, dirName);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "bench@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Bench Test"], { cwd: dir });

  // Create source files of known sizes
  for (const f of files) {
    const line = `// benchmark test content for ${f.name}\nfunction example() { return true; }\n`;
    let content = `// ${f.name}\n`;
    while (Buffer.byteLength(content) < f.size) content += line;
    const fullPath = join(dir, f.name);
    const parts = f.name.split("/");
    if (parts.length > 1) mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(fullPath, content.slice(0, f.size), "utf-8");
  }

  // Write .refrev
  writeFileSync(join(dir, ".refrev"), "abc123deadbeef\n", "utf-8");

  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "--allow-empty", "-m", "init", "--author", "T <t@t.com>"], {
    cwd: dir,
  });

  return dir;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ashlr-refs-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("benchmark-refs", () => {
  test("produces expected JSON shape with byRepo, byLanguage, crossLanguageMean", async () => {
    // Create 3 synthetic ref repos
    const nodeRef = makeGitRepo("node-sdk", [
      { name: "src/index.ts", size: 5_000 },
      { name: "src/util.ts", size: 8_000 },
      { name: "src/core.ts", size: 15_000 },
      { name: "src/types.ts", size: 3_000 },
      { name: "src/stream.ts", size: 25_000 },
    ]);
    const pyRef = makeGitRepo("python-lib", [
      { name: "lib/module.py", size: 6_000 },
      { name: "lib/utils.py", size: 9_000 },
      { name: "lib/core.py", size: 18_000 },
      { name: "lib/types.py", size: 3_500 },
      { name: "lib/ops.py", size: 30_000 },
    ]);
    const rsRef = makeGitRepo("rust-project", [
      { name: "src/lib.rs", size: 7_000 },
      { name: "src/io.rs", size: 12_000 },
      { name: "src/async.rs", size: 20_000 },
      { name: "src/util.rs", size: 4_000 },
      { name: "src/runtime.rs", size: 28_000 },
    ]);

    const outFile = join(tmpDir, "out.json");
    const result = await runRefsBenchmark({
      pluginRoot: tmpDir,
      out: outFile,
      dryRun: false,
      refOverrides: {
        "node-sdk": nodeRef,
        "python-lib": pyRef,
        "rust-project": rsRef,
      },
    });

    // Top-level shape
    expect(typeof result.crossLanguageMeasuredAt).toBe("string");
    expect(new Date(result.crossLanguageMeasuredAt).getTime()).toBeGreaterThan(0);
    expect(typeof result.crossLanguageMean).toBe("number");
    expect(typeof result.crossLanguageSavingsPct).toBe("number");

    // byRepo should have all 3 keys
    expect(Object.keys(result.byRepo)).toContain("node-sdk");
    expect(Object.keys(result.byRepo)).toContain("python-lib");
    expect(Object.keys(result.byRepo)).toContain("rust-project");

    // each byRepo entry has required fields
    for (const key of ["node-sdk", "python-lib", "rust-project"]) {
      const r = result.byRepo[key]!;
      expect(typeof r.meanRatio).toBe("number");
      expect(typeof r.savingsPct).toBe("number");
      expect(r.meanRatio).toBeGreaterThanOrEqual(0);
      expect(r.meanRatio).toBeLessThanOrEqual(10); // allow edit overhead
      expect(r.savingsPct).toBeCloseTo((1 - r.meanRatio) * 100, 4);
      expect(typeof r.perTool.read.mean).toBe("number");
      expect(typeof r.perTool.grep.mean).toBe("number");
      expect(typeof r.perTool.edit.mean).toBe("number");
      expect(typeof r.refrev).toBe("string");
      expect(r.refrev).toBe("abc123deadbeef");
    }

    // byLanguage should have ts/py/rs
    expect(Object.keys(result.byLanguage)).toContain("ts");
    expect(Object.keys(result.byLanguage)).toContain("py");
    expect(Object.keys(result.byLanguage)).toContain("rs");

    for (const lang of ["ts", "py", "rs"]) {
      const l = result.byLanguage[lang]!;
      expect(typeof l.meanRatio).toBe("number");
      expect(typeof l.savingsPct).toBe("number");
    }

    // crossLanguageMean = mean of 3 repo meanRatios
    const expectedMean =
      (result.byRepo["node-sdk"]!.meanRatio +
        result.byRepo["python-lib"]!.meanRatio +
        result.byRepo["rust-project"]!.meanRatio) /
      3;
    expect(result.crossLanguageMean).toBeCloseTo(expectedMean, 6);
    expect(result.crossLanguageSavingsPct).toBeCloseTo((1 - expectedMean) * 100, 4);
  });

  test("crossLanguageMean is arithmetic mean of the 3 repo overall means", async () => {
    const nodeRef = makeGitRepo("node-sdk2", [
      { name: "src/a.ts", size: 10_000 },
      { name: "src/b.ts", size: 20_000 },
    ]);
    const pyRef = makeGitRepo("python-lib2", [
      { name: "lib/a.py", size: 10_000 },
      { name: "lib/b.py", size: 20_000 },
    ]);
    const rsRef = makeGitRepo("rust-project2", [
      { name: "src/a.rs", size: 10_000 },
      { name: "src/b.rs", size: 20_000 },
    ]);

    const result = await runRefsBenchmark({
      pluginRoot: tmpDir,
      out: join(tmpDir, "out2.json"),
      dryRun: true,
      refOverrides: {
        "node-sdk": nodeRef,
        "python-lib": pyRef,
        "rust-project": rsRef,
      },
    });

    const r1 = result.byRepo["node-sdk"]!.meanRatio;
    const r2 = result.byRepo["python-lib"]!.meanRatio;
    const r3 = result.byRepo["rust-project"]!.meanRatio;
    const expected = (r1 + r2 + r3) / 3;

    expect(result.crossLanguageMean).toBeCloseTo(expected, 10);
  });

  test("dry-run does not write output file", async () => {
    const nodeRef = makeGitRepo("node-sdk3", [{ name: "src/x.ts", size: 5_000 }]);
    const pyRef = makeGitRepo("python-lib3", [{ name: "lib/x.py", size: 5_000 }]);
    const rsRef = makeGitRepo("rust-project3", [{ name: "src/x.rs", size: 5_000 }]);

    const outFile = join(tmpDir, "should-not-exist.json");

    await runRefsBenchmark({
      pluginRoot: tmpDir,
      out: outFile,
      dryRun: true,
      refOverrides: {
        "node-sdk": nodeRef,
        "python-lib": pyRef,
        "rust-project": rsRef,
      },
    });

    expect(existsSync(outFile)).toBe(false);
  });

  test("missing ref directory is skipped gracefully (no throw)", async () => {
    const nodeRef = makeGitRepo("node-sdk4", [{ name: "src/x.ts", size: 5_000 }]);

    // python-lib and rust-project not provided — will use default paths that don't exist
    const result = await runRefsBenchmark({
      pluginRoot: join(tmpDir, "nonexistent-plugin-root"),
      out: join(tmpDir, "out3.json"),
      dryRun: true,
      refOverrides: {
        "node-sdk": nodeRef,
        // python-lib and rust-project intentionally missing
      },
    });

    // Only node-sdk should be in byRepo
    expect(Object.keys(result.byRepo)).toContain("node-sdk");
    expect(Object.keys(result.byRepo).length).toBe(1);

    // crossLanguageMean should be just the one repo's mean
    expect(result.crossLanguageMean).toBeCloseTo(result.byRepo["node-sdk"]!.meanRatio, 6);
  });

  test("output file is written and merges with existing JSON", async () => {
    const nodeRef = makeGitRepo("node-sdk5", [
      { name: "src/a.ts", size: 8_000 },
      { name: "src/b.ts", size: 15_000 },
    ]);
    const pyRef = makeGitRepo("python-lib5", [
      { name: "lib/a.py", size: 8_000 },
      { name: "lib/b.py", size: 15_000 },
    ]);
    const rsRef = makeGitRepo("rust-project5", [
      { name: "src/a.rs", size: 8_000 },
      { name: "src/b.rs", size: 15_000 },
    ]);

    const outFile = join(tmpDir, "merged.json");

    // Pre-populate with a fake existing benchmark JSON (simulating self-repo bench)
    writeFileSync(
      outFile,
      JSON.stringify({
        version: 2,
        measuredAt: "2026-04-25T00:00:00.000Z",
        repo: { url: "local", commit: "abc", files: 10, loc: 1000 },
        samples: { "ashlr__read": [], "ashlr__grep": [], "ashlr__edit": [] },
        aggregate: {
          "ashlr__read": { mean: 0.18, p50: 0.12, p90: 0.47 },
          "ashlr__grep": { mean: 0.07, p50: 0.01, p90: 0.24 },
          "ashlr__edit": { mean: 1.0, p50: 0.48, p90: 2.5 },
          overall: { mean: 0.26 },
        },
        methodology: "test",
      }),
      "utf-8",
    );

    await runRefsBenchmark({
      pluginRoot: tmpDir,
      out: outFile,
      dryRun: false,
      refOverrides: {
        "node-sdk": nodeRef,
        "python-lib": pyRef,
        "rust-project": rsRef,
      },
    });

    expect(existsSync(outFile)).toBe(true);
    const written = JSON.parse(readFileSync(outFile, "utf-8"));

    // Original fields preserved
    expect(written.version).toBe(2);
    expect(written.aggregate.overall.mean).toBeCloseTo(0.26, 4);

    // New sections added
    expect(typeof written.crossLanguageMean).toBe("number");
    expect(typeof written.crossLanguageSavingsPct).toBe("number");
    expect(typeof written.byRepo).toBe("object");
    expect(typeof written.byLanguage).toBe("object");
    expect(typeof written.crossLanguageMeasuredAt).toBe("string");

    // Values are sane
    expect(written.crossLanguageMean).toBeGreaterThan(0);
    expect(written.crossLanguageMean).toBeLessThanOrEqual(2);
    expect(written.crossLanguageSavingsPct).toBeCloseTo(
      (1 - written.crossLanguageMean) * 100,
      4,
    );
  });

  test("byLanguage maps match byRepo language codes", async () => {
    const nodeRef = makeGitRepo("node-sdk6", [{ name: "src/a.ts", size: 6_000 }]);
    const pyRef = makeGitRepo("python-lib6", [{ name: "lib/a.py", size: 6_000 }]);
    const rsRef = makeGitRepo("rust-project6", [{ name: "src/a.rs", size: 6_000 }]);

    const result = await runRefsBenchmark({
      pluginRoot: tmpDir,
      out: join(tmpDir, "lang.json"),
      dryRun: true,
      refOverrides: {
        "node-sdk": nodeRef,
        "python-lib": pyRef,
        "rust-project": rsRef,
      },
    });

    expect(result.byLanguage["ts"]?.meanRatio).toBeCloseTo(
      result.byRepo["node-sdk"]!.meanRatio,
      6,
    );
    expect(result.byLanguage["py"]?.meanRatio).toBeCloseTo(
      result.byRepo["python-lib"]!.meanRatio,
      6,
    );
    expect(result.byLanguage["rs"]?.meanRatio).toBeCloseTo(
      result.byRepo["rust-project"]!.meanRatio,
      6,
    );
  });
});
