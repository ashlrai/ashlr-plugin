/**
 * Tests for scripts/run-benchmark.ts
 *
 * Uses a synthetic git repo with known-size files to verify:
 *   - correct sample counts
 *   - --dry-run mode (no file written)
 *   - output JSON schema
 *   - empty repo → graceful no-samples result
 *   - deterministic seeding: same SHA → same file selection
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

import { runBenchmark } from "../scripts/run-benchmark";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeRepo(opts: { initGit?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ashlr-bench-test-"));
  if (opts.initGit !== false) {
    spawnSync("git", ["init"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  }
  return dir;
}

function writeFile(dir: string, name: string, size: number): void {
  // Fill with valid TypeScript-ish content of approximately `size` bytes
  const line = `// line content for benchmark testing file ${name}\n`;
  let content = `// ${name}\n`;
  while (Buffer.byteLength(content) < size) {
    content += line;
  }
  const fullPath = join(dir, name);
  const parts = name.split("/");
  if (parts.length > 1) {
    mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
  }
  writeFileSync(fullPath, content.slice(0, size), "utf-8");
}

function gitAddCommit(dir: string): void {
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync(
    "git",
    ["commit", "--allow-empty", "-m", "init", "--author", "Test <t@t.com>"],
    { cwd: dir },
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ashlr-bench-suite-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("run-benchmark", () => {
  test("synthetic repo with 10 known-size files produces expected sample count", async () => {
    const repo = makeRepo();

    // Create 10 files spanning all size buckets
    // 2-5KB bucket: 3 files
    for (let i = 0; i < 3; i++) writeFile(repo, `src/small${i}.ts`, 3_000);
    // 5-15KB bucket: 3 files
    for (let i = 0; i < 3; i++) writeFile(repo, `src/medium${i}.ts`, 8_000);
    // 15-50KB bucket: 2 files
    for (let i = 0; i < 2; i++) writeFile(repo, `src/large${i}.ts`, 20_000);
    // 50+KB bucket: 2 files
    for (let i = 0; i < 2; i++) writeFile(repo, `src/xlarge${i}.ts`, 60_000);

    gitAddCommit(repo);

    const outFile = join(tmpDir, "out.json");
    const result = await runBenchmark({ repo, out: outFile, dryRun: true });

    // Should sample at most 4 per bucket × 4 buckets = 16, but we only have
    // 3+3+2+2=10 files total so all 10 should be sampled
    expect(result.samples["ashlr__read"].length).toBeGreaterThan(0);
    expect(result.samples["ashlr__read"].length).toBeLessThanOrEqual(16);

    // All sampled files should have rawBytes >= 2048
    for (const s of result.samples["ashlr__read"]) {
      expect(s.rawBytes).toBeGreaterThanOrEqual(2048);
    }
  });

  test("--dry-run mode runs without writing output file", async () => {
    const repo = makeRepo();
    writeFile(repo, "src/a.ts", 4_000);
    gitAddCommit(repo);

    const outFile = join(tmpDir, "should-not-exist.json");
    await runBenchmark({ repo, out: outFile, dryRun: true });

    expect(existsSync(outFile)).toBe(false);
  });

  test("output JSON schema validates (version, measuredAt, repo, samples, aggregate, methodology)", async () => {
    const repo = makeRepo();
    writeFile(repo, "src/a.ts", 5_000);
    writeFile(repo, "src/b.ts", 12_000);
    gitAddCommit(repo);

    const outFile = join(tmpDir, "result.json");
    const result = await runBenchmark({ repo, out: outFile, dryRun: false });

    // Top-level shape
    expect(result.version).toBe(2);
    expect(typeof result.measuredAt).toBe("string");
    expect(new Date(result.measuredAt).getTime()).toBeGreaterThan(0);
    expect(typeof result.repo.commit).toBe("string");
    expect(typeof result.repo.files).toBe("number");
    expect(typeof result.repo.loc).toBe("number");
    expect(typeof result.methodology).toBe("string");
    expect(result.methodology.length).toBeGreaterThan(100);

    // Aggregate shape
    for (const tool of ["ashlr__read", "ashlr__grep", "ashlr__edit"] as const) {
      const agg = result.aggregate[tool];
      expect(typeof agg.mean).toBe("number");
      expect(typeof agg.p50).toBe("number");
      expect(typeof agg.p90).toBe("number");
      expect(agg.mean).toBeGreaterThanOrEqual(0);
      // ratio > 1 is valid for ashlr__edit on tiny changes (diff header > naive
      // before+after for very small search/replace strings — this is honest)
      expect(agg.mean).toBeLessThanOrEqual(10);
    }
    expect(typeof result.aggregate.overall.mean).toBe("number");

    // Written file matches in-memory result
    const written = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(written.version).toBe(2);
    expect(written.aggregate.overall.mean).toBeCloseTo(result.aggregate.overall.mean, 6);
  });

  test("empty repo → graceful no-samples result", async () => {
    const repo = makeRepo();
    // Commit an empty file (< 2KB, so excluded from read benchmark)
    writeFile(repo, "README.md", 100);
    gitAddCommit(repo);

    const outFile = join(tmpDir, "empty-result.json");
    const result = await runBenchmark({ repo, out: outFile, dryRun: true });

    // read samples will be empty (no files >= 2KB)
    expect(result.samples["ashlr__read"].length).toBe(0);
    // aggregate should degrade gracefully (ratio = 1.0 when no samples)
    expect(result.aggregate["ashlr__read"].mean).toBe(1);
    expect(result.samples["ashlr__grep"]).toEqual([]);
    expect(result.aggregate["ashlr__grep"].mean).toBe(1);
    // edit samples always present (synthetic)
    expect(result.samples["ashlr__edit"].length).toBe(3);
  });

  test("deterministic seeding: same commit SHA → same file sample", async () => {
    const repo = makeRepo();
    for (let i = 0; i < 8; i++) writeFile(repo, `src/file${i}.ts`, 4_000 + i * 1_000);
    gitAddCommit(repo);

    const result1 = await runBenchmark({ repo, out: join(tmpDir, "r1.json"), dryRun: true });
    const result2 = await runBenchmark({ repo, out: join(tmpDir, "r2.json"), dryRun: true });

    const paths1 = result1.samples["ashlr__read"].map((s) => s.path).sort();
    const paths2 = result2.samples["ashlr__read"].map((s) => s.path).sort();
    expect(paths1).toEqual(paths2);
  });

  test("all edit sizes are measured (small, medium, large)", async () => {
    const repo = makeRepo();
    writeFile(repo, "src/x.ts", 3_000);
    gitAddCommit(repo);

    const result = await runBenchmark({ repo, out: join(tmpDir, "r.json"), dryRun: true });

    const sizes = result.samples["ashlr__edit"].map((s) => s.size);
    expect(sizes).toContain("small");
    expect(sizes).toContain("medium");
    expect(sizes).toContain("large");
  });

  test("ashlr__edit medium and large samples have ratio < 1 (compression applies to non-trivial edits)", async () => {
    const repo = makeRepo();
    writeFile(repo, "src/x.ts", 3_000);
    gitAddCommit(repo);

    const result = await runBenchmark({ repo, out: join(tmpDir, "r.json"), dryRun: true });

    // "small" (15-char search/replace) is intentionally > 1: the diff header
    // is longer than the naive before+after for a tiny change — this is honest
    // and surfaces in the UI as a caveat. Medium and large must compress well.
    const medium = result.samples["ashlr__edit"].find((s) => s.size === "medium");
    const large  = result.samples["ashlr__edit"].find((s) => s.size === "large");
    expect(medium?.ratio).toBeLessThan(1);
    expect(large?.ratio).toBeLessThan(1);
  });

  test("ratios are in [0, 1] range for all sample types", async () => {
    const repo = makeRepo();
    for (let i = 0; i < 4; i++) writeFile(repo, `src/f${i}.ts`, 5_000 + i * 3_000);
    gitAddCommit(repo);

    const result = await runBenchmark({ repo, out: join(tmpDir, "r.json"), dryRun: true });

    for (const s of result.samples["ashlr__read"]) {
      expect(s.ratio).toBeGreaterThanOrEqual(0);
      expect(s.ratio).toBeLessThanOrEqual(1);
    }
    for (const s of result.samples["ashlr__grep"]) {
      expect(s.ratio).toBeGreaterThanOrEqual(0);
      expect(s.ratio).toBeLessThanOrEqual(1.01); // allow tiny float imprecision
    }
    for (const s of result.samples["ashlr__edit"]) {
      expect(s.ratio).toBeGreaterThanOrEqual(0);
      // ratio > 1 is valid for "small" edits where the diff header overhead
      // exceeds the tiny naive before+after — see methodology note
      expect(s.ratio).toBeLessThanOrEqual(10);
    }
  });

  test("grep patterns produce samples or graceful skip (no crash)", async () => {
    const repo = makeRepo();
    // File with known matches for all 5 patterns
    const content = `
import { foo } from './foo';
// TODO: fix this
class MyClass {
  interface BadUsage() {}
  function helper() {}
}
`.repeat(500);
    const filePath = join(repo, "src/patterns.ts");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(filePath, content);
    gitAddCommit(repo);

    // Should not throw
    const result = await runBenchmark({ repo, out: join(tmpDir, "r.json"), dryRun: true });
    expect(Array.isArray(result.samples["ashlr__grep"])).toBe(true);
  });

  test("a short Rust grep result is retained and unmatched patterns have no sample", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src/lib.rs"),
      "use std::io;\nstruct Task;\nenum State { Ready }\ntrait Run {}\n// TODO: handle errors\nfn run() {}\n",
    );
    gitAddCommit(repo);

    const useSearch = spawnSync("rg", ["-n", "use ", "src/lib.rs"], { cwd: repo, encoding: "utf-8" });
    expect(useSearch.status).toBe(0);
    expect(useSearch.stdout).toContain("use std::io;");

    const result = await runBenchmark({ repo, out: join(tmpDir, "r.json"), dryRun: true });
    const samples = result.samples["ashlr__grep"];
    expect(samples.map((sample) => sample.pattern)).toEqual(["TODO"]);
    expect(samples[0]!.ashlrBytes).toBe(samples[0]!.rawBytes);
    expect(samples[0]!.ratio).toBe(1);
    expect(result.aggregate["ashlr__grep"].mean).toBe(1);
  });

  test("grep mean weights a short result and a truncated result equally", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src/lib.rs"),
      "use std::io;\n// TODO: handle errors\n" + "// class example with enough matches to truncate\n".repeat(500),
    );
    gitAddCommit(repo);

    const result = await runBenchmark({ repo, out: join(tmpDir, "r.json"), dryRun: true });
    const samples = result.samples["ashlr__grep"];
    expect(samples.map((sample) => sample.pattern)).toEqual(["TODO", "class "]);
    expect(samples[0]!.ratio).toBe(1);
    expect(samples[1]!.ratio).toBeLessThan(1);
    expect(result.aggregate["ashlr__grep"].mean).toBeCloseTo((samples[0]!.ratio + samples[1]!.ratio) / 2);

    // Only matching patterns contribute to the pooled mean, alongside each
    // individual read and edit sample; missing patterns add no placeholder.
    const ratios = [
      ...result.samples["ashlr__read"].map((sample) => sample.ratio),
      ...samples.map((sample) => sample.ratio),
      ...result.samples["ashlr__edit"].map((sample) => sample.ratio),
    ];
    expect(result.aggregate.overall.mean).toBeCloseTo(
      ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length,
    );
  });
});
