#!/usr/bin/env bun
/**
 * scripts/benchmark-refs.ts
 *
 * Multi-repo aggregator for the ashlr-plugin token-efficiency benchmark.
 *
 * Iterates the three curated reference repos in bench/refs/:
 *   - node-sdk   (TypeScript, vercel/ai subset)
 *   - python-lib (Python, pandas subset)
 *   - rust-project (Rust, tokio subset)
 *
 * For each repo, calls runBenchmark() from scripts/run-benchmark.ts, then
 * aggregates per-repo results into docs/benchmarks-v2.json with new sections:
 *   - byRepo: per-repo meanRatio and per-tool breakdown
 *   - byLanguage: per-language meanRatio (ts/py/rs)
 *   - crossLanguageMean: arithmetic mean across all 3 repos (the headline number)
 *
 * Extends the existing schema — the original samples/aggregate fields are
 * preserved from the existing benchmarks-v2.json (plugin-self benchmark).
 *
 * Usage:
 *   bun run scripts/benchmark-refs.ts
 *   bun run scripts/benchmark-refs.ts --out /tmp/bench-refs.json
 *   bun run scripts/benchmark-refs.ts --dry-run
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

import { runBenchmark } from "./run-benchmark";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RefRepoResult {
  repoKey: string;
  language: string;
  upstreamRepo: string;
  refrev: string;
  meanRatio: number; // 0–1; lower = more savings
  savingsPct: number; // (1 - meanRatio) * 100
  perTool: {
    read: { mean: number; p50: number; p90: number };
    grep: { mean: number; p50: number; p90: number };
    edit: { mean: number; p50: number; p90: number };
  };
}

export interface MultiRepoBenchmarkSections {
  crossLanguageMeasuredAt: string;
  byRepo: Record<string, RefRepoResult>;
  byLanguage: Record<string, { language: string; meanRatio: number; savingsPct: number }>;
  crossLanguageMean: number; // ratio, 0–1
  crossLanguageSavingsPct: number; // (1 - crossLanguageMean) * 100
}

// ---------------------------------------------------------------------------
// Reference repo configuration
// ---------------------------------------------------------------------------

interface RefConfig {
  key: string;
  language: string;
  upstreamRepo: string;
}

const REFS: RefConfig[] = [
  {
    key: "node-sdk",
    language: "ts",
    upstreamRepo: "github.com/vercel/ai",
  },
  {
    key: "python-lib",
    language: "py",
    upstreamRepo: "github.com/pandas-dev/pandas",
  },
  {
    key: "rust-project",
    language: "rs",
    upstreamRepo: "github.com/tokio-rs/tokio",
  },
];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface Args {
  out: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args: Args = {
    out: resolve(pluginRoot, "docs/benchmarks-v2.json"),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) args.out = resolve(argv[++i]!);
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readRefrev(refDir: string): string {
  const p = resolve(refDir, ".refrev");
  if (!existsSync(p)) return "unknown";
  return readFileSync(p, "utf-8").trim();
}

// ---------------------------------------------------------------------------
// Ensure a directory is a git repo (init + commit if needed)
// ---------------------------------------------------------------------------

function ensureGitRepo(dir: string): void {
  const gitDir = resolve(dir, ".git");
  if (existsSync(gitDir)) return; // already a git repo

  console.log(`[benchmark-refs] git init ${dir}`);
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "bench@ashlr.ai"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "ashlr-bench"], { cwd: dir });
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "--allow-empty", "-m", "bench-init", "--author", "ashlr-bench <bench@ashlr.ai>"], {
    cwd: dir,
  });
}

// ---------------------------------------------------------------------------
// Core aggregation (exported for tests)
// ---------------------------------------------------------------------------

export async function runRefsBenchmark(opts: {
  pluginRoot: string;
  out: string;
  dryRun: boolean;
  /** Override ref dirs for testing */
  refOverrides?: Record<string, string>;
}): Promise<MultiRepoBenchmarkSections> {
  const { pluginRoot, out, dryRun, refOverrides } = opts;
  const refsBaseDir = resolve(pluginRoot, "bench/refs");

  const byRepo: Record<string, RefRepoResult> = {};
  const tmpDir = resolve(pluginRoot, "tmp-bench-refs");

  for (const ref of REFS) {
    const refDir = refOverrides?.[ref.key] ?? resolve(refsBaseDir, ref.key);

    if (!existsSync(refDir)) {
      console.warn(`[benchmark-refs] SKIP ${ref.key}: directory not found at ${refDir}`);
      continue;
    }

    const tmpOut = resolve(tmpDir, `${ref.key}.json`);
    // Ensure tmp dir exists
    const { mkdirSync } = await import("fs");
    mkdirSync(tmpDir, { recursive: true });

    console.log(`\n[benchmark-refs] === ${ref.key} (${ref.language}) ===`);
    // Ref dirs are committed as plain directories (no .git); init on first run.
    ensureGitRepo(refDir);
    const result = await runBenchmark({ repo: refDir, out: tmpOut, dryRun: true });

    const refrev = readRefrev(refDir);
    const perTool: RefRepoResult["perTool"] = {
      read: result.aggregate["ashlr__read"],
      grep: result.aggregate["ashlr__grep"],
      edit: result.aggregate["ashlr__edit"],
    };

    const meanRatio = result.aggregate.overall.mean;
    byRepo[ref.key] = {
      repoKey: ref.key,
      language: ref.language,
      upstreamRepo: ref.upstreamRepo,
      refrev,
      meanRatio,
      savingsPct: (1 - meanRatio) * 100,
      perTool,
    };

    console.log(
      `[benchmark-refs] ${ref.key}: overall −${((1 - meanRatio) * 100).toFixed(1)}%  ` +
        `read −${((1 - perTool.read.mean) * 100).toFixed(1)}%  ` +
        `grep −${((1 - perTool.grep.mean) * 100).toFixed(1)}%  ` +
        `edit −${((1 - perTool.edit.mean) * 100).toFixed(1)}%`,
    );
  }

  // ---------------------------------------------------------------------------
  // byLanguage: map language code → mean ratio (weighted by repo count, 1:1 here)
  // ---------------------------------------------------------------------------
  const byLanguage: MultiRepoBenchmarkSections["byLanguage"] = {};
  for (const ref of REFS) {
    const r = byRepo[ref.key];
    if (!r) continue;
    byLanguage[ref.language] = {
      language: ref.language,
      meanRatio: r.meanRatio,
      savingsPct: r.savingsPct,
    };
  }

  // ---------------------------------------------------------------------------
  // crossLanguageMean: arithmetic mean of the 3 repo overall means
  // ---------------------------------------------------------------------------
  const repoMeans = Object.values(byRepo).map((r) => r.meanRatio);
  const crossLanguageMean =
    repoMeans.length > 0 ? repoMeans.reduce((s, r) => s + r, 0) / repoMeans.length : 1;
  const crossLanguageSavingsPct = (1 - crossLanguageMean) * 100;

  const sections: MultiRepoBenchmarkSections = {
    crossLanguageMeasuredAt: new Date().toISOString(),
    byRepo,
    byLanguage,
    crossLanguageMean,
    crossLanguageSavingsPct,
  };

  // ---------------------------------------------------------------------------
  // Merge into existing benchmarks-v2.json
  // ---------------------------------------------------------------------------
  if (!dryRun) {
    let existing: Record<string, unknown> = {};
    if (existsSync(out)) {
      try {
        existing = JSON.parse(readFileSync(out, "utf-8")) as Record<string, unknown>;
      } catch {
        console.warn(`[benchmark-refs] could not parse existing ${out}, overwriting`);
      }
    }

    const merged = {
      ...existing,
      ...sections,
    };

    writeFileSync(out, JSON.stringify(merged, null, 2), "utf-8");
    console.log(`\n[benchmark-refs] wrote ${out}`);
  } else {
    console.log("\n[benchmark-refs] --dry-run: skipping file write");
  }

  console.log(`\n[benchmark-refs] CROSS-LANGUAGE RESULT:`);
  console.log(
    `[benchmark-refs]   crossLanguageMean −${crossLanguageSavingsPct.toFixed(1)}%` +
      ` (ts −${((1 - (byLanguage["ts"]?.meanRatio ?? 1)) * 100).toFixed(1)}%,` +
      ` py −${((1 - (byLanguage["py"]?.meanRatio ?? 1)) * 100).toFixed(1)}%,` +
      ` rs −${((1 - (byLanguage["rs"]?.meanRatio ?? 1)) * 100).toFixed(1)}%)`,
  );

  return sections;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await runRefsBenchmark({ pluginRoot, out: args.out, dryRun: args.dryRun });
  } catch (err) {
    console.error(
      "[benchmark-refs] ERROR:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}
