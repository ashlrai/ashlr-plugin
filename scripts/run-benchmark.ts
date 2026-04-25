#!/usr/bin/env bun
/**
 * scripts/run-benchmark.ts
 *
 * Reproducible benchmark runner for the ashlr-plugin token-efficiency layer.
 *
 * Usage:
 *   bun run scripts/run-benchmark.ts
 *   bun run scripts/run-benchmark.ts --repo /path/to/repo
 *   bun run scripts/run-benchmark.ts --out docs/benchmarks-v2.json
 *   bun run scripts/run-benchmark.ts --dry-run
 *
 * Measures actual byte/token reduction for ashlr__read, ashlr__grep, and
 * ashlr__edit by calling the handler functions directly — no MCP layer.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, relative } from "path";
import { spawnSync } from "child_process";

import {
  estimateTokensFromString,
  snipCompact,
  type Message,
} from "@ashlr/core-efficiency";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface Args {
  repo: string;
  out: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: process.cwd(),
    out: resolve(process.cwd(), "docs/benchmarks-v2.json"),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo" && argv[i + 1]) args.repo = resolve(argv[++i]!);
    else if (argv[i] === "--out" && argv[i + 1]) args.out = resolve(argv[++i]!);
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic from repo commit SHA
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  };
}

function seedFromCommit(sha: string): number {
  // fold 40-char hex SHA into a 32-bit int
  let n = 0;
  for (let i = 0; i < sha.length; i++) {
    n = (Math.imul(n, 31) + sha.charCodeAt(i)) >>> 0;
  }
  return n;
}

function seededSample<T>(arr: T[], n: number, rand: () => number): T[] {
  const copy = arr.slice();
  const result: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(rand() * copy.length);
    result.push(copy.splice(idx, 1)[0]!);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Repo metadata
// ---------------------------------------------------------------------------

interface RepoMeta {
  url: string;
  commit: string;
  files: number;
  loc: number;
}

function gitOutput(args: string[], cwd: string): string {
  const res = spawnSync("git", args, { encoding: "utf-8", cwd });
  return (res.stdout ?? "").trim();
}

function getRepoMeta(repoPath: string): RepoMeta {
  const commit = gitOutput(["rev-parse", "HEAD"], repoPath) || "unknown";
  const url = gitOutput(["remote", "get-url", "origin"], repoPath) || "local";
  const lsFiles = spawnSync("git", ["ls-files"], { encoding: "utf-8", cwd: repoPath });
  const allFiles = (lsFiles.stdout ?? "")
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  // Count LOC via wc -l on git-tracked files (best-effort)
  let loc = 0;
  try {
    const wcRes = spawnSync("git", ["ls-files", "-z"], {
      encoding: "buffer",
      cwd: repoPath,
      timeout: 10_000,
    });
    if (wcRes.stdout) {
      const files = wcRes.stdout
        .toString("utf-8")
        .split("\0")
        .filter(Boolean)
        .map((f) => resolve(repoPath, f));
      for (const f of files) {
        try {
          const content = readFileSync(f, "utf-8");
          loc += content.split("\n").length;
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    loc = allFiles.length * 30; // rough fallback
  }

  return { url, commit, files: allFiles.length, loc };
}

// ---------------------------------------------------------------------------
// File enumeration + size-bucket sampling
// ---------------------------------------------------------------------------

type SizeBucket = "2-5KB" | "5-15KB" | "15-50KB" | "50+KB";

interface FileSample {
  path: string;
  bucket: SizeBucket;
  bytes: number;
}

function sizeKB(bytes: number): SizeBucket {
  const kb = bytes / 1024;
  if (kb < 5) return "2-5KB";
  if (kb < 15) return "5-15KB";
  if (kb < 50) return "15-50KB";
  return "50+KB";
}

function enumerateFiles(repoPath: string): FileSample[] {
  const lsFiles = spawnSync("git", ["ls-files"], {
    encoding: "utf-8",
    cwd: repoPath,
    timeout: 30_000,
  });
  if (lsFiles.status !== 0) {
    throw new Error(
      `git ls-files failed in ${repoPath}: ${lsFiles.stderr ?? "unknown error"}`,
    );
  }
  const files = (lsFiles.stdout ?? "")
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  const result: FileSample[] = [];
  for (const f of files) {
    const abs = resolve(repoPath, f);
    try {
      const content = readFileSync(abs);
      const bytes = content.length;
      if (bytes < 2048) continue; // snipCompact only fires on > 2KB
      result.push({ path: abs, bucket: sizeKB(bytes), bytes });
    } catch {
      // skip locked/binary files
    }
  }
  return result;
}

function selectSample(files: FileSample[], rand: () => number): FileSample[] {
  const buckets: Record<SizeBucket, FileSample[]> = {
    "2-5KB": [],
    "5-15KB": [],
    "15-50KB": [],
    "50+KB": [],
  };
  for (const f of files) buckets[f.bucket].push(f);

  // Pick up to 4 from each bucket, targeting ~16 total
  const picked: FileSample[] = [];
  for (const bucket of ["2-5KB", "5-15KB", "15-50KB", "50+KB"] as SizeBucket[]) {
    const n = Math.min(4, buckets[bucket].length);
    picked.push(...seededSample(buckets[bucket], n, rand));
  }
  return picked;
}

// ---------------------------------------------------------------------------
// ashlr__read measurement
// ---------------------------------------------------------------------------

interface ReadSample {
  path: string;
  bucket: SizeBucket;
  rawBytes: number;
  rawTokens: number;
  ashlrBytes: number;
  ashlrTokens: number;
  ratio: number; // 0–1, lower = more savings; 0.3 means 70% reduction
}

function measureRead(file: FileSample): ReadSample | null {
  try {
    const content = readFileSync(file.path, "utf-8");
    const rawBytes = Buffer.byteLength(content, "utf-8");
    const rawTokens = estimateTokensFromString(content);

    // Replicate ashlrRead logic: wrap as tool_result, apply snipCompact
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "bench-read", content }],
      },
    ];
    const compact = snipCompact(msgs);
    const block = (compact[0]!.content as { type: string; content: string }[])[0]!;
    const out = (block as { content: string }).content;

    const ashlrBytes = Buffer.byteLength(out, "utf-8");
    const ashlrTokens = estimateTokensFromString(out);
    const ratio = rawTokens > 0 ? ashlrTokens / rawTokens : 1;

    return {
      path: file.path,
      bucket: file.bucket,
      rawBytes,
      rawTokens,
      ashlrBytes,
      ashlrTokens,
      ratio,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ashlr__grep measurement
// ---------------------------------------------------------------------------

const GREP_PATTERNS = ["function ", "import ", "TODO", "class ", "interface "];

interface GrepSample {
  pattern: string;
  rawBytes: number;
  rawTokens: number;
  ashlrBytes: number;
  ashlrTokens: number;
  ratio: number;
  method: "rg-truncated";
}

function resolveRg(): string {
  // Try Bun.which first (respects PATH without shell aliases)
  const bunWhich =
    typeof (globalThis as { Bun?: { which(s: string): string | null } }).Bun !== "undefined"
      ? (globalThis as { Bun: { which(s: string): string | null } }).Bun.which("rg")
      : null;
  if (bunWhich) return bunWhich;

  // Common binary locations (ordered by likelihood); include codex-vendored rg
  const candidates = [
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
    // codex vendor path — actual executable, not the dotslash wrapper
    "/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/path/rg",
    "/opt/homebrew/lib/node_modules/@openai/codex/bin/rg",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Cross-platform fallback: `where` on Windows, `which` on POSIX.
  const whichCmd = process.platform === "win32" ? "where" : "which";
  const typeRes = spawnSync(whichCmd, ["rg"], { encoding: "utf-8" });
  const typePath = (typeRes.stdout ?? "").split(/[\r\n]/)[0]?.trim() ?? "";
  if (typePath && existsSync(typePath)) return typePath;

  return "rg";
}

function measureGrep(pattern: string, repoPath: string): GrepSample | null {
  try {
    const rgBin = resolveRg();
    const res = spawnSync(rgBin, ["--json", "-n", pattern, repoPath], {
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const raw = res.stdout ?? "";
    if (!raw.trim()) return null;

    const rawBytes = Buffer.byteLength(raw, "utf-8");
    const rawTokens = estimateTokensFromString(raw);

    // Replicate rg-fallback path in ashlrGrep: truncate to 4000 chars head+tail
    const truncated =
      raw.length > 4000
        ? raw.slice(0, 2000) + "\n\n[... truncated ...]\n\n" + raw.slice(-1000)
        : raw;

    const ashlrBytes = Buffer.byteLength(truncated, "utf-8");
    const ashlrTokens = estimateTokensFromString(truncated);
    const ratio = rawTokens > 0 ? ashlrTokens / rawTokens : 1;

    return {
      pattern,
      rawBytes,
      rawTokens,
      ashlrBytes,
      ashlrTokens,
      ratio,
      method: "rg-truncated",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ashlr__edit measurement
// ---------------------------------------------------------------------------

type EditSize = "small" | "medium" | "large";

interface EditSample {
  size: EditSize;
  searchChars: number;
  replaceChars: number;
  naiveBytes: number;  // search + replace as raw text
  naiveTokens: number;
  ashlrBytes: number;  // diff-summary representation
  ashlrTokens: number;
  ratio: number;
}

function summarizeEditForBench(
  search: string,
  replace: string,
  fileSize: number,
): string {
  // Replicate the summarizeEdit output from efficiency-server.ts
  const first = (s: string) => s.split("\n")[0]?.slice(0, 72) ?? "";
  return [
    `[ashlr__edit] file.ts  ·  1 of 1 hunks applied`,
    `  - removed (${estimateTokensFromString(search)} tok):  ${first(search)}${search.length > 72 ? "…" : ""}`,
    `  + added   (${estimateTokensFromString(replace)} tok):  ${first(replace)}${replace.length > 72 ? "…" : ""}`,
  ].join("\n");
}

function measureEdit(size: EditSize): EditSample {
  // Synthetic edits of known sizes
  const scenarios: Record<EditSize, { search: string; replace: string; fileSize: number }> = {
    small: {
      search: "const foo = 1;\n",
      replace: "const foo = 2;\n",
      fileSize: 3_000,
    },
    medium: {
      search: [
        "function processItems(items: string[]): string[] {",
        "  return items.filter(Boolean).map(s => s.trim());",
        "}",
        "",
        "function formatOutput(result: string[]): string {",
        "  return result.join(', ');",
        "}",
      ].join("\n"),
      replace: [
        "function processItems(items: string[]): string[] {",
        "  return items",
        "    .filter(Boolean)",
        "    .map(s => s.trim())",
        "    .sort();",
        "}",
        "",
        "function formatOutput(result: string[]): string {",
        "  return result.join(', ');",
        "}",
      ].join("\n"),
      fileSize: 12_000,
    },
    large: {
      search: Array.from({ length: 60 }, (_, i) =>
        i % 3 === 0
          ? `  // step ${i}: process batch`
          : i % 3 === 1
          ? `  const result${i} = items.slice(${i * 10}, ${i * 10 + 10}).map(transform);`
          : `  output.push(...result${i - 1});`,
      ).join("\n"),
      replace: Array.from({ length: 60 }, (_, i) =>
        i % 3 === 0
          ? `  // step ${i}: process batch (optimized)`
          : i % 3 === 1
          ? `  const result${i} = batchTransform(items, ${i * 10}, ${i * 10 + 10});`
          : `  output.push(...result${i - 1});`,
      ).join("\n"),
      fileSize: 40_000,
    },
  };

  const { search, replace, fileSize } = scenarios[size];

  // Naive: ship full before+after (2× file approximated as search+replace + surrounding context)
  const naiveText = `BEFORE:\n${search}\n\nAFTER:\n${replace}`;
  const naiveBytes = Buffer.byteLength(naiveText, "utf-8");
  const naiveTokens = estimateTokensFromString(naiveText);

  // ashlr__edit: send only the diff summary
  const summary = summarizeEditForBench(search, replace, fileSize);
  const ashlrBytes = Buffer.byteLength(summary, "utf-8");
  const ashlrTokens = estimateTokensFromString(summary);
  const ratio = naiveTokens > 0 ? ashlrTokens / naiveTokens : 1;

  return {
    size,
    searchChars: search.length,
    replaceChars: replace.length,
    naiveBytes,
    naiveTokens,
    ashlrBytes,
    ashlrTokens,
    ratio,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface ToolAggregate {
  mean: number;
  p50: number;
  p90: number;
}

function aggregate(ratios: number[]): ToolAggregate {
  if (ratios.length === 0) return { mean: 1, p50: 1, p90: 1 };
  const sorted = ratios.slice().sort((a, b) => a - b);
  const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
  const p90 = sorted[Math.floor(sorted.length * 0.9)]!;
  return { mean, p50, p90 };
}

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

interface BenchmarkOutput {
  version: 2;
  measuredAt: string;
  repo: RepoMeta;
  samples: {
    "ashlr__read": ReadSample[];
    "ashlr__grep": GrepSample[];
    "ashlr__edit": EditSample[];
  };
  aggregate: {
    "ashlr__read": ToolAggregate;
    "ashlr__grep": ToolAggregate;
    "ashlr__edit": ToolAggregate;
    overall: { mean: number };
  };
  methodology: string;
}

const METHODOLOGY = `
Measurement methodology (version 2):

**ashlr__read**: For each sampled source file, we measure raw file bytes and
token count (chars/4 heuristic). We then apply the same snipCompact
transformation used at runtime — wrapping the content in a tool_result message
and calling snipCompact() — and measure the resulting byte/token count. The
ratio is ashlrTokens / rawTokens. Files below 2 KB are excluded because
snipCompact only fires on tool results > 2 000 chars; savings are zero by
design for small files.

Files are selected deterministically: the repo HEAD commit SHA is folded into a
32-bit seed (mulberry32 PRNG), then up to 4 files are sampled from each of four
size buckets (2–5 KB, 5–15 KB, 15–50 KB, 50+ KB). Re-running on the same
commit always picks the same files.

**ashlr__grep**: Five common patterns (function, import, TODO, class, interface)
are run via rg --json against the repo root. Raw output bytes are measured
directly. The ashlr__grep fallback path (no genome) truncates output to 4 000
chars (head 2 000 + tail 1 000). The ratio is truncated/raw.

Note: when a .ashlrcode/genome/ index is present, real-world grep savings are
substantially higher. This benchmark measures only the conservative
no-genome baseline.

**ashlr__edit**: Three synthetic edits (small ~15 chars, medium ~300 chars,
large ~3 000 chars) compare the naive "ship before+after as text" approach
against ashlr__edit's diff-summary format (one header line + removed/added
first-lines). The ratio is summary tokens / naive tokens.

**Aggregation**: per-tool mean/p50/p90 are computed over each tool's ratio
values (lower ratio = more savings). The \`overall.mean\` is pooled across
every individual sample regardless of tool — so tools with more samples (read
has 15, grep has 5, edit has 3) weight the overall figure proportionally.
That makes the headline number reflect the workload mix, not a uniform
per-tool average. The unweighted mean of per-tool means is intentionally NOT
published because it gives equal weight to a 3-sample tool and a 15-sample
tool, which over-weights the synthetic edit overhead.

Token counts use the chars/4 heuristic, the same estimator the plugin uses at
runtime for savings accounting.
`.trim();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runBenchmark(opts: {
  repo: string;
  out: string;
  dryRun: boolean;
}): Promise<BenchmarkOutput> {
  const { repo, out, dryRun } = opts;

  if (!existsSync(repo)) {
    throw new Error(`Repo path does not exist: ${repo}`);
  }

  console.log(`[run-benchmark] repo: ${repo}`);
  const meta = getRepoMeta(repo);
  console.log(`[run-benchmark] commit: ${meta.commit}  files: ${meta.files}  loc: ${meta.loc}`);

  // Seed PRNG from commit SHA
  const rand = mulberry32(seedFromCommit(meta.commit));

  // --- ashlr__read ---
  console.log("[run-benchmark] enumerating files...");
  const allFiles = enumerateFiles(repo);
  if (allFiles.length === 0) {
    console.warn("[run-benchmark] WARNING: no files >= 2KB found — read samples will be empty");
  }
  const sampled = selectSample(allFiles, rand);
  console.log(`[run-benchmark] sampled ${sampled.length} files for read benchmark`);

  const readSamples: ReadSample[] = [];
  for (const file of sampled) {
    const s = measureRead(file);
    if (s) {
      readSamples.push(s);
      const pct = ((1 - s.ratio) * 100).toFixed(1);
      console.log(
        `[run-benchmark]   read  ${relative(repo, file.path).padEnd(50)} ${file.bucket.padEnd(8)} ${pct}% saved`,
      );
    } else {
      console.warn(`[run-benchmark]   read  SKIP ${file.path}`);
    }
  }

  // --- ashlr__grep ---
  console.log("[run-benchmark] measuring grep...");
  const grepSamples: GrepSample[] = [];
  for (const pattern of GREP_PATTERNS) {
    const s = measureGrep(pattern, repo);
    if (s) {
      grepSamples.push(s);
      const pct = ((1 - s.ratio) * 100).toFixed(1);
      console.log(
        `[run-benchmark]   grep  "${pattern.trim()}".padEnd(12) ${pct}% saved  (${s.rawBytes} raw → ${s.ashlrBytes} ashlr bytes)`,
      );
    } else {
      console.warn(`[run-benchmark]   grep  no matches for "${pattern}" — skipped`);
    }
  }

  // --- ashlr__edit ---
  console.log("[run-benchmark] measuring edit...");
  const editSamples: EditSample[] = [];
  for (const size of ["small", "medium", "large"] as EditSize[]) {
    const s = measureEdit(size);
    editSamples.push(s);
    const pct = ((1 - s.ratio) * 100).toFixed(1);
    console.log(`[run-benchmark]   edit  ${size.padEnd(8)} ${pct}% saved`);
  }

  // --- Aggregates ---
  const readAgg = aggregate(readSamples.map((s) => s.ratio));
  const grepAgg = aggregate(grepSamples.map((s) => s.ratio));
  const editAgg = aggregate(editSamples.map((s) => s.ratio));
  const allRatios = [
    ...readSamples.map((s) => s.ratio),
    ...grepSamples.map((s) => s.ratio),
    ...editSamples.map((s) => s.ratio),
  ];
  const overallMean = allRatios.length > 0
    ? allRatios.reduce((s, r) => s + r, 0) / allRatios.length
    : 1;

  const output: BenchmarkOutput = {
    version: 2,
    measuredAt: new Date().toISOString(),
    repo: meta,
    samples: {
      "ashlr__read": readSamples,
      "ashlr__grep": grepSamples,
      "ashlr__edit": editSamples,
    },
    aggregate: {
      "ashlr__read": readAgg,
      "ashlr__grep": grepAgg,
      "ashlr__edit": editAgg,
      overall: { mean: overallMean },
    },
    methodology: METHODOLOGY,
  };

  const overallPct = ((1 - overallMean) * 100).toFixed(1);
  console.log(`\n[run-benchmark] RESULT: overall mean −${overallPct}% token savings`);
  console.log(`[run-benchmark]   read  mean −${((1 - readAgg.mean) * 100).toFixed(1)}%`);
  console.log(`[run-benchmark]   grep  mean −${((1 - grepAgg.mean) * 100).toFixed(1)}%`);
  console.log(`[run-benchmark]   edit  mean −${((1 - editAgg.mean) * 100).toFixed(1)}%`);

  if (!dryRun) {
    writeFileSync(out, JSON.stringify(output, null, 2), "utf-8");
    console.log(`[run-benchmark] wrote ${out}`);
  } else {
    console.log("[run-benchmark] --dry-run: skipping file write");
  }

  return output;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  try {
    await runBenchmark(args);
  } catch (err) {
    console.error("[run-benchmark] ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
