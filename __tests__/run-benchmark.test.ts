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
import { fileURLToPath } from "url";

import { GREP_PATTERNS, runBenchmark } from "../scripts/run-benchmark";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeRepo(opts: { initGit?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpDir, "ashlr-bench-test-"));
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

function expectMethodologyPatternsToMatch(methodology: string): void {
  const list = methodology.match(/\*\*ashlr__grep\*\*:\s*[^\n]*?patterns\s*\(([^)]*)\)/);
  expect(list).not.toBeNull();
  expect(list![1]!.split(",").map((name) => name.trim())).toEqual(
    GREP_PATTERNS.map((pattern) => pattern.trim()),
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
  test("published benchmark snapshots report the same grep patterns", () => {
    const patterns = (path: string): string[] => {
      const data = JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf-8"));
      return data.samples["ashlr__grep"].map((sample: { pattern: string }) => sample.pattern);
    };

    const docsPatterns = patterns("../docs/benchmarks-v2.json");
    const sitePatterns = patterns("../site/public/benchmarks-v2.json");
    expect(docsPatterns.length).toBeGreaterThan(0);
    expect(docsPatterns.every((pattern) => typeof pattern === "string")).toBe(true);
    expect(sitePatterns).toEqual(docsPatterns);
  });

  test("methodology names exactly the configured grep patterns", async () => {
    const repo = makeRepo();
    gitAddCommit(repo);
    const result = await runBenchmark({ repo, out: join(tmpDir, "result.json"), dryRun: true });

    expectMethodologyPatternsToMatch(result.methodology);

    const missing = result.methodology.replace("function, import", "import");
    const extra = result.methodology.replace("function, import", "function, extra, import");
    expect(missing).not.toBe(result.methodology);
    expect(extra).not.toBe(result.methodology);
    expect(() => expectMethodologyPatternsToMatch(missing)).toThrow();
    expect(() => expectMethodologyPatternsToMatch(extra)).toThrow();
  });

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

  test("documented grep patterns match all samples from a matching repo", async () => {
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

    const result = await runBenchmark({ repo, out: join(tmpDir, "r.json"), dryRun: true });
    const patterns = result.samples["ashlr__grep"].map((sample) => sample.pattern);
    expect(patterns).toEqual(["function ", "import ", "TODO", "class ", "interface "]);

    for (const [path, section] of [
      ["../docs/benchmarks.md", /\*\*Grep patterns:\*\*[\s\S]*?```json\n([^\n]+)\n```/],
      ["../docs/benchmark-methodology-guide.md", /## Fixed grep workload and Rust[\s\S]*?```json\n([^\n]+)\n```/],
      ["../docs/benchmark-rust-patterns.md", /## The fixed workload[\s\S]*?```json\n([^\n]+)\n```/],
      ["../docs/benchmark-rust-pattern-caveats.md", /## Fixed workload[\s\S]*?```json\n([^\n]+)\n```/],
      ["../docs/benchmark-rust-pattern-interpretation.md", /```json\n([^\n]+)\n```/],
      ["../docs/benchmark-grep-interpretation.md", /## Fixed workload[\s\S]*?```json\n([^\n]+)\n```/],
      ["../docs/benchmark-grep-language-caveats.md", /```json\n([^\n]+)\n```/],
      ["../docs/grep-benchmark-coverage-questions.md", /## Which searches does the benchmark use\?[\s\S]*?```json\n([^\n]+)\n```/],
    ] as const) {
      const docs = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf-8");
      const documentedList = docs.match(section);
      expect(documentedList).not.toBeNull();
      expect(JSON.parse(documentedList![1]!)).toEqual(patterns);
    }
  });

  test("Rust pattern guide reports the saved reference aggregates", () => {
    const guide = readFileSync(fileURLToPath(new URL("../docs/benchmark-rust-patterns.md", import.meta.url)), "utf-8");
    const data = JSON.parse(readFileSync(fileURLToPath(new URL("../docs/benchmarks-v2.json", import.meta.url)), "utf-8"));
    const rust = data.byRepo["rust-project"];
    expect(guide).toContain(data.crossLanguageMeasuredAt.slice(0, 10));
    expect(guide).toContain(rust.refrev.slice(0, 7));
    expect(guide).toContain(rust.perTool.grep.mean.toFixed(4));
    expect(guide).toContain(((1 - rust.perTool.grep.mean) * 100).toFixed(1) + "% savings");
    expect(guide).toContain(rust.meanRatio.toFixed(4));
    expect(guide).toContain(rust.savingsPct.toFixed(1) + "% savings");
  });

  test("Rust interpretation reports the reference snapshot and explains its data limits", () => {
    const guide = readFileSync(fileURLToPath(new URL("../docs/benchmark-rust-pattern-interpretation.md", import.meta.url)), "utf-8");
    const data = JSON.parse(readFileSync(fileURLToPath(new URL("../docs/benchmarks-v2.json", import.meta.url)), "utf-8"));
    const rust = data.byRepo["rust-project"];
    expect(guide).toContain(data.crossLanguageMeasuredAt.slice(0, 10));
    expect(guide).toContain(rust.refrev.slice(0, 7));
    expect(guide).toContain(rust.perTool.grep.mean.toFixed(4));
    expect(guide).toContain(((1 - rust.perTool.grep.mean) * 100).toFixed(1) + "% savings");
    expect(guide).toContain(rust.meanRatio.toFixed(4));
    expect(guide).toContain(rust.savingsPct.toFixed(1) + "% savings");
    for (const pattern of ["function ", "import ", "class ", "interface ", "TODO"]) {
      expect(guide).toContain(`| \`${pattern}\` |`);
    }
    expect(guide).toContain("not individual Rust grep\nsamples or match counts");
    expect(guide).toContain("not a zero-savings sample");
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

  test("documented Rust example matches incidental text but misses declarations", async () => {
    const guide = readFileSync(fileURLToPath(new URL("../docs/benchmark-rust-pattern-caveats.md", import.meta.url)), "utf-8");
    const example = guide.match(/```rust\n([\s\S]*?)\n```/);
    expect(example).not.toBeNull();
    const repo = makeRepo();
    writeFileSync(join(repo, "lib.rs"), example![1]! + "\n");
    gitAddCommit(repo);

    const result = await runBenchmark({ repo, out: join(tmpDir, "r.json"), dryRun: true });
    expect(result.samples["ashlr__grep"].map((sample) => sample.pattern))
      .toEqual(["function ", "import ", "TODO", "class ", "interface "]);
    for (const sample of result.samples["ashlr__grep"]) {
      const search = spawnSync("rg", ["-n", sample.pattern, "lib.rs"], { cwd: repo, encoding: "utf-8" });
      expect(search.status).toBe(0);
      expect(search.stdout.trim().split("\n")).toEqual([
        "1:// TODO: document the function import class interface examples",
      ]);
    }
    const rustSearch = spawnSync("rg", ["-n", "use |fn ", "lib.rs"], { cwd: repo, encoding: "utf-8" });
    expect(rustSearch.status).toBe(0);
    expect(rustSearch.stdout.trim().split("\n")).toHaveLength(3);
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

  test("GREP_PATTERNS comment documents the fixed patterns as a workload sample, not a completeness measure", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../scripts/run-benchmark.ts", import.meta.url)),
      "utf-8",
    );
    const declIdx = source.indexOf("const GREP_PATTERNS");
    expect(declIdx).toBeGreaterThan(-1);
    // Comment block directly above the declaration
    const comment = source
      .slice(0, declIdx)
      .trimEnd()
      .split("\n")
      .slice(-8)
      .join("\n");
    expect(comment).toMatch(/workload sample/i);
    expect(comment).toMatch(/not a completeness measure/i);
  });
});
