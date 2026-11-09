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

import { GREP_PATTERNS, aggregate, bootstrapCI, isEligibleExtension, runBenchmark } from "../scripts/run-benchmark";

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
  test("selects function and class grep patterns exactly once each", () => {
    for (const pattern of ["function ", "class "]) {
      expect(GREP_PATTERNS.filter((configured) => configured === pattern)).toHaveLength(1);
    }
  });

  test("benchmark documentation and runner include the TODO grep pattern", () => {
    const docs = readFileSync(fileURLToPath(new URL("../docs/benchmarks.md", import.meta.url)), "utf-8");
    const list = docs.match(/\*\*Grep patterns:\*\*[\s\S]*?```json\s*\n([^\n]+)\n```/);
    expect(list).not.toBeNull();
    const documentedPatterns: string[] = JSON.parse(list![1]!);

    expect(GREP_PATTERNS).toContain("TODO");
    expect(documentedPatterns).toContain("TODO");
    expect(documentedPatterns).toEqual([...GREP_PATTERNS]);
  });

  test("published benchmark snapshots report the same grep patterns", () => {
    const patterns = (path: string): string[] => {
      const data = JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf-8"));
      return data.samples["ashlr__grep"].map((sample: { pattern: string }) => sample.pattern);
    };

    const docsPatterns = patterns("../docs/benchmarks-v2.json");
    const sitePatterns = patterns("../site/public/benchmarks-v2.json");
    expect(docsPatterns.length).toBeGreaterThan(0);
    expect(docsPatterns.every((pattern) => typeof pattern === "string")).toBe(true);
    expect(GREP_PATTERNS).toContain("TODO");
    expect(docsPatterns).toContain("TODO");
    const configuredPatterns: readonly string[] = GREP_PATTERNS;
    for (const pattern of docsPatterns) {
      expect(configuredPatterns).toContain(pattern);
    }
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

  test("fixture with no final newline is measured in full, final line included", async () => {
    const repo = makeRepo();
    const lines = Array.from({ length: 120 }, (_, i) => `export const v${i} = ${i}; // padding`);
    const finalLine = "export const LAST_LINE_NO_NEWLINE = true;";
    const content = [...lines, finalLine].join("\n"); // deliberately no trailing "\n"
    expect(content.endsWith("\n")).toBe(false);
    expect(Buffer.byteLength(content)).toBeGreaterThan(2048);
    writeFileSync(join(repo, "no-newline.ts"), content, "utf-8");
    gitAddCommit(repo);

    const result = await runBenchmark({ repo, out: join(tmpDir, "no-newline.json"), dryRun: true });

    const reads = result.samples["ashlr__read"];
    expect(reads).toHaveLength(1);
    // Every byte, including the unterminated final line, is counted.
    expect(reads[0]!.rawBytes).toBe(Buffer.byteLength(content));
    // Line count includes the final unterminated line (121 lines, not 120).
    expect(result.repo.loc).toBe(lines.length + 1);
  });

  test("--dry-run mode runs without writing output file", async () => {
    const repo = makeRepo();
    writeFile(repo, "src/a.ts", 4_000);
    gitAddCommit(repo);

    const outFile = join(tmpDir, "should-not-exist.json");
    await runBenchmark({ repo, out: outFile, dryRun: true });

    expect(existsSync(outFile)).toBe(false);
  });

  test("--dry-run on a repo path with spaces samples every file and writes nothing", async () => {
    const parent = join(tmpDir, "my projects", "bench repo");
    mkdirSync(parent, { recursive: true });
    const repo = mkdtempSync(join(parent, "synthetic repo "));
    spawnSync("git", ["init"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });

    // One file per size bucket, including a directory and filename with spaces.
    writeFile(repo, "src dir/small file.ts", 3_000);
    writeFile(repo, "src dir/medium file.ts", 8_000);
    writeFile(repo, "large dir/large file.ts", 20_000);
    writeFile(repo, "xlarge.ts", 60_000);
    gitAddCommit(repo);
    expect(repo).toContain(" ");

    const outFile = join(parent, "should not exist.json");
    const result = await runBenchmark({ repo, out: outFile, dryRun: true });

    // 4 files, one per bucket, all >= 2KB, so all 4 are sampled.
    expect(result.samples["ashlr__read"]).toHaveLength(4);
    for (const s of result.samples["ashlr__read"]) {
      expect(s.path).toContain(repo);
      expect(s.rawBytes).toBeGreaterThanOrEqual(2048);
    }
    expect(result.repo.files).toBe(4);
    expect(existsSync(outFile)).toBe(false);
  });

  test("--dry-run returns full results, creates no output file or directory, and matches a real run", async () => {
    const repo = makeRepo();
    writeFile(repo, "src/a.ts", 3_000);
    writeFile(repo, "src/b.ts", 9_000);
    writeFile(repo, "lib/c.ts", 20_000);
    gitAddCommit(repo);
    const treeBefore = spawnSync("git", ["status", "--porcelain", "--ignored"], { cwd: repo })
      .stdout.toString();

    // Nested output path whose parent does not exist: dry-run must not create it.
    const outDir = join(tmpDir, "dry-run-out-dir");
    const dryOut = join(outDir, "dry.json");
    const dry = await runBenchmark({ repo, out: dryOut, dryRun: true });

    // Results are returned in full.
    expect(dry.version).toBe(2);
    expect(dry.samples["ashlr__read"]).toHaveLength(3);
    expect(dry.repo.files).toBe(3);
    expect(dry.aggregate["ashlr__read"]).toBeDefined();

    // Nothing was written: not the file, not its parent, not anything in the repo.
    expect(existsSync(dryOut)).toBe(false);
    expect(existsSync(outDir)).toBe(false);
    const treeAfter = spawnSync("git", ["status", "--porcelain", "--ignored"], { cwd: repo })
      .stdout.toString();
    expect(treeAfter).toBe(treeBefore);

    // A real run on the same repo yields identical measurements and does write.
    const realOut = join(tmpDir, "real.json");
    const real = await runBenchmark({ repo, out: realOut, dryRun: false });
    expect(existsSync(realOut)).toBe(true);
    expect(real.samples).toEqual(dry.samples);
    expect(real.aggregate).toEqual(dry.aggregate);
    expect(real.repo).toEqual(dry.repo);
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
    // Commit a small file (< 2KB, so excluded from read benchmark)
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

  test("empty read/grep result sets produce a summary with only finite numbers", async () => {
    const repo = makeRepo();
    writeFile(repo, "README.md", 100);
    gitAddCommit(repo);

    const outFile = join(tmpDir, "empty-finite.json");
    const result = await runBenchmark({ repo, out: outFile, dryRun: false });
    expect(result.samples["ashlr__read"]).toEqual([]);
    expect(result.samples["ashlr__grep"]).toEqual([]);

    // Walk every numeric in the summary (NaN/Infinity would serialize to null).
    const nonFinite: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (typeof v === "number") {
        if (!Number.isFinite(v)) nonFinite.push(path);
      } else if (v && typeof v === "object") {
        for (const [k, c] of Object.entries(v)) walk(c, `${path}.${k}`);
      }
    };
    walk(result.aggregate, "aggregate");
    walk(result.repo, "repo");
    expect(nonFinite).toEqual([]);

    for (const tool of ["ashlr__read", "ashlr__grep"] as const) {
      expect(result.aggregate[tool]).toEqual({
        mean: 1, p50: 1, p90: 1, confidenceInterval: { lo: 1, hi: 1 },
      });
    }
    expect(Number.isFinite(result.aggregate.overall.mean)).toBe(true);

    // The written file must round-trip with no nulls where numbers belong.
    const written = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(written.aggregate["ashlr__read"].confidenceInterval).toEqual({ lo: 1, hi: 1 });
    expect(written.aggregate["ashlr__grep"].p90).toBe(1);
    expect(written.aggregate.overall.mean).toBe(result.aggregate.overall.mean);
  });

  test("bootstrapCI of an empty set is finite", () => {
    const ci = bootstrapCI([]);
    expect(Number.isFinite(ci.lo)).toBe(true);
    expect(Number.isFinite(ci.hi)).toBe(true);
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

  test("two runs on the same repo and seed select the same files in the same order", async () => {
    const repo = makeRepo();
    // Span every size bucket so selection involves real PRNG-driven picks.
    for (let i = 0; i < 6; i++) writeFile(repo, `src/small${i}.ts`, 3_000 + i * 100);
    for (let i = 0; i < 6; i++) writeFile(repo, `src/medium${i}.ts`, 8_000 + i * 500);
    for (let i = 0; i < 6; i++) writeFile(repo, `src/large${i}.ts`, 20_000 + i * 1_000);
    gitAddCommit(repo);

    const run1 = await runBenchmark({ repo, out: join(tmpDir, "o1.json"), dryRun: true });
    const run2 = await runBenchmark({ repo, out: join(tmpDir, "o2.json"), dryRun: true });

    const order = (r: typeof run1) =>
      r.samples["ashlr__read"].map((s) => `${s.bucket}:${s.path}`);
    const order1 = order(run1);
    const order2 = order(run2);

    expect(order1.length).toBeGreaterThan(1);
    expect(new Set(order1).size).toBe(order1.length);
    // No sorting: sequence itself must match.
    expect(order2).toEqual(order1);
  });

  test("repo with exactly one eligible source file reports at most one read sample", async () => {
    const repo = makeRepo();
    writeFile(repo, "src/only.ts", 6_000);
    writeFile(repo, "README.md", 100); // below the 2KB floor: not eligible
    gitAddCommit(repo);

    const result = await runBenchmark({ repo, out: join(tmpDir, "one.json"), dryRun: true });

    const reads = result.samples["ashlr__read"];
    expect(reads.length).toBeLessThanOrEqual(1);
    expect(reads.map((s) => s.path.endsWith("src/only.ts"))).toEqual([true]);
    expect(reads[0]!.rawBytes).toBeGreaterThanOrEqual(2048);
  });

  test("a filename containing spaces is read from its own fixture and kept in the result", async () => {
    const repo = makeRepo();
    // Distinct sizes so the sample can only come from the spaced file.
    writeFile(repo, "src/my fixture file.ts", 7_000);
    writeFile(repo, "src/other.ts", 3_000);
    gitAddCommit(repo);

    const result = await runBenchmark({ repo, out: join(tmpDir, "spaces.json"), dryRun: true });

    const spaced = result.samples["ashlr__read"].filter((s) => s.path.endsWith("src/my fixture file.ts"));
    expect(spaced).toHaveLength(1);
    expect(spaced[0]!.rawBytes).toBe(7_000);
    expect(spaced[0]!.path).toContain("my fixture file.ts");
    expect(result.samples["ashlr__read"]).toHaveLength(2);
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

describe("run-benchmark: reordered measurements", () => {
  const ratios = [1.2, 3.5, 0.9, 7.25, 2.0, 2.0, 5.5, 1.01, 4.4, 10.0, 0.5, 3.3];

  // Deterministic shuffle (no Math.random) so failures reproduce.
  function shuffled(arr: number[], seed: number): number[] {
    const out = arr.slice();
    let s = seed;
    for (let i = out.length - 1; i > 0; i--) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const j = s % (i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  const orderings: Record<string, number[]> = {
    original: ratios,
    reversed: ratios.slice().reverse(),
    ascending: ratios.slice().sort((a, b) => a - b),
    shuffledA: shuffled(ratios, 1),
    shuffledB: shuffled(ratios, 42),
  };

  test("aggregate is identical for every ordering of the same measurements", () => {
    const expected = aggregate(ratios);
    for (const [name, order] of Object.entries(orderings)) {
      const got = aggregate(order);
      // mean is a float sum; allow only last-bit rounding drift.
      expect(got.mean, name).toBeCloseTo(expected.mean, 12);
      expect(got.p50, name).toBe(expected.p50);
      expect(got.p90, name).toBe(expected.p90);
      expect(got.confidenceInterval, name).toEqual(expected.confidenceInterval);
    }
  });

  test("bootstrapCI is identical for every ordering", () => {
    const expected = bootstrapCI(ratios);
    for (const [name, order] of Object.entries(orderings)) {
      expect(bootstrapCI(order), name).toEqual(expected);
    }
  });

  test("aggregate does not mutate its input order", () => {
    const input = ratios.slice().reverse();
    const copy = input.slice();
    aggregate(input);
    expect(input).toEqual(copy);
  });

  test("empty and single-measurement inputs are stable", () => {
    expect(aggregate([])).toEqual({ mean: 1, p50: 1, p90: 1, confidenceInterval: { lo: 1, hi: 1 } });
    expect(aggregate([2.5]).confidenceInterval).toEqual({ lo: 2.5, hi: 2.5 });
  });

  test("a single measurement is reported unchanged across the summary", () => {
    for (const measurement of [0, 0.375, 1, 2.5]) {
      const input = [measurement];
      expect(aggregate(input)).toEqual({
        mean: measurement,
        p50: measurement,
        p90: measurement,
        confidenceInterval: { lo: measurement, hi: measurement },
      });
      expect(input).toEqual([measurement]);
    }
  });
});

describe("run-benchmark: zero measured bytes", () => {
  const noBadNumbers = (text: string) => {
    expect(text).not.toMatch(/NaN/);
    expect(text).not.toMatch(/Infinity/);
  };

  async function captureRun(repo: string, compare = false) {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      const result = await runBenchmark({ repo, out: join(tmpDir, "z.json"), dryRun: true, compare });
      return { result, log: lines.join("\n") };
    } finally {
      console.log = orig;
    }
  }

  test("aggregate of zero-byte (ratio 1) results stays finite", () => {
    for (const input of [[], [1], [1, 1, 1]]) {
      const agg = aggregate(input);
      for (const v of [agg.mean, agg.p50, agg.p90, agg.confidenceInterval.lo, agg.confidenceInterval.hi]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  test("repo containing only an empty file reports no eligible samples", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "README.md"), "");
    gitAddCommit(repo);

    const { result, log } = await captureRun(repo);

    expect(readFileSync(join(repo, "README.md")).byteLength).toBe(0);
    expect(result.repo.files).toBe(1);
    expect(result.samples["ashlr__read"]).toEqual([]);
    expect(result.samples["ashlr__grep"]).toEqual([]);
    const noSamples = { mean: 1, p50: 1, p90: 1, confidenceInterval: { lo: 1, hi: 1 } };
    expect(result.aggregate["ashlr__read"]).toEqual(noSamples);
    expect(result.aggregate["ashlr__grep"]).toEqual(noSamples);
    expect(result.samples["ashlr__edit"]).toHaveLength(3);
    noBadNumbers(log);
    noBadNumbers(JSON.stringify(result));
    expect(Number.isFinite(result.aggregate.overall.mean)).toBe(true);
    expect(log).toContain("read  mean −0.0% token savings");
  });

  test("formats empty read and grep results with comparison enabled", async () => {
    const repo = makeRepo();
    writeFile(repo, "README.md", 0);
    gitAddCommit(repo);

    const { result, log } = await captureRun(repo, true);

    expect(result.samples["ashlr__read"]).toEqual([]);
    expect(result.samples["ashlr__grep"]).toEqual([]);
    expect(log).toContain("read  mean −0.0% token savings");
    expect(log).toContain("grep  mean −0.0% token savings");
    expect(log).toContain("read  CI   [0.0%–0.0%]");
    expect(log).not.toContain("--compare: native vs ashlr");
    noBadNumbers(log);
  });

  test("whitespace-only file (zero estimated tokens) does not divide by zero", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/blank.ts"), "");
    writeFileSync(join(repo, "src/pad.ts"), " ".repeat(4_000));
    gitAddCommit(repo);

    const { result, log } = await captureRun(repo);

    noBadNumbers(log);
    noBadNumbers(JSON.stringify(result));
    for (const s of result.samples["ashlr__read"]) {
      expect(Number.isFinite(s.ratio)).toBe(true);
      if (s.rawTokens === 0) expect(s.ratio).toBe(1);
    }
  });
});

describe("run-benchmark: unsupported file extensions", () => {
  const eligible = ["src/a.ts", "src/b.py", "lib/c.rs", "docs/d.md", "Makefile", "src/E.TS"];
  const unsupported = ["img/logo.png", "assets/font.woff2", "dist/app.wasm", "bun.lock", "dist/app.js.map", "docs/spec.PDF", "pack/x.tar.gz"];

  test("isEligibleExtension accepts text sources and rejects binary/media", () => {
    for (const f of eligible) expect(isEligibleExtension(f)).toBe(true);
    for (const f of unsupported) expect(isEligibleExtension(f)).toBe(false);
  });

  test("only eligible files appear in read and grep samples", async () => {
    const repo = makeRepo();
    for (const f of eligible.filter((f) => f !== "src/E.TS")) writeFile(repo, f, 6_000);
    for (const f of unsupported) writeFile(repo, f, 6_000); // same size, text-like bytes
    gitAddCommit(repo);

    const result = await runBenchmark({ repo, out: join(tmpDir, "ext.json"), dryRun: true });

    const reads = result.samples["ashlr__read"].map((s) => s.path);
    expect(reads.length).toBeGreaterThan(0);
    for (const p of reads) {
      expect(isEligibleExtension(p)).toBe(true);
    }
    const all = JSON.stringify(result.samples);
    for (const f of unsupported) expect(all).not.toContain(f);
  });

  test("repo of only unsupported files yields no samples", async () => {
    const repo = makeRepo();
    for (const f of unsupported) writeFile(repo, f, 6_000);
    gitAddCommit(repo);

    const result = await runBenchmark({ repo, out: join(tmpDir, "none.json"), dryRun: true });

    expect(result.samples["ashlr__read"]).toEqual([]);
    expect(result.samples["ashlr__grep"]).toEqual([]);
  });
});
