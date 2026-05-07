#!/usr/bin/env bun
/**
 * ashlr grep calibration harness.
 *
 * Measures the empirical ratio between raw ripgrep output size and the genome-
 * compressed size returned by ashlr__grep. Writes results to
 * ~/.ashlr/calibration.json so efficiency-server.ts can replace its
 * hardcoded 4× multiplier with a data-driven value.
 *
 * Usage:
 *   bun run scripts/calibrate-grep.ts
 *   bun run scripts/calibrate-grep.ts --workload /path/to/workload.jsonl
 *   bun run scripts/calibrate-grep.ts --out /path/to/calibration.json
 *
 * Workload format (~/.ashlr/calibration-workload.jsonl):
 *   { "cwd": "/path/to/project", "pattern": "someSymbol" }
 *   { "cwd": "/path/to/other",   "pattern": "anotherPattern" }
 *
 * If no workload file is found, a bundled synthetic fixture is used instead
 * (runs rg against the ashlr-plugin source tree itself).
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

import { type CalibrationFile, type CalibrationSample } from "./read-calibration";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Workload {
  cwd: string;
  pattern: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveRg(): string {
  // Mirror the same resolution logic as efficiency-server.ts so we run the
  // same binary.
  return (
    (typeof (globalThis as { Bun?: { which(b: string): string | null } }).Bun !== "undefined"
      ? (globalThis as { Bun: { which(b: string): string | null } }).Bun.which("rg")
      : null) ??
    ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"].find((p) => {
      try {
        require("fs").accessSync(p);
        return true;
      } catch {
        return false;
      }
    }) ??
    "rg"
  );
}

/**
 * Run `rg --json <pattern> <cwd>` and return the raw stdout bytes.
 * Returns null if rg is unavailable or the call times out.
 */
function rgRawBytes(pattern: string, cwd: string): number | null {
  try {
    const res = spawnSync(resolveRg(), ["--json", "-n", pattern, cwd], {
      encoding: "buffer",
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    // status 0 = matches found, status 1 = no matches — both are valid.
    if (res.status !== 0 && res.status !== 1) return null;
    const buf = res.stdout as Buffer | null;
    return buf ? buf.length : 0;
  } catch {
    return null;
  }
}

/**
 * Try to load genome helpers and retrieve compressed output size.
 * Returns null when the genome is absent or the import fails.
 *
 * Root-cause fix (v1.29): the genome is a project-knowledge store (vision,
 * strategies, milestones). Its TF-IDF scorer filters out any section with
 * score === 0. Code-level patterns like "recordSaving" or "spawnSync" never
 * appear in section tags/titles/summaries, so retrieveSectionsV2 returns [] for
 * every synthetic workload pattern — causing the caller to fall through to the
 * syntheticSampleNoGenome() 4× estimate.
 *
 * Fix: when retrieveSectionsV2 returns 0 sections (pattern has no genome match),
 * retry with an empty query to get the *core* genome sections (north-star,
 * current milestone, active strategies). These are what the real ashlr__grep
 * tool returns for any query that scores zero sections — they represent the
 * actual compressed output the tool would emit, giving a real measurement
 * rather than the synthetic rawBytes/4 fallback.
 *
 * We try the @ashlr/core-efficiency import dynamically so the script still
 * runs (in synthetic-fixture mode) on machines where the module is absent.
 */
async function genomeCompressedBytes(
  pattern: string,
  cwd: string,
): Promise<{ bytes: number; wasCoreFallback: boolean } | null> {
  try {
    // Dynamic imports so a missing genome doesn't throw at module load time.
    const { genomeExists, retrieveSectionsV2, retrieveSections, formatGenomeForPrompt } =
      await import("@ashlr/core-efficiency");
    const { findParentGenome } = await import("./genome-link");

    let genomeRoot: string | null = null;
    if (genomeExists(cwd)) {
      genomeRoot = cwd;
    } else {
      const parent = findParentGenome(cwd);
      if (parent) genomeRoot = parent;
    }

    if (!genomeRoot) return null;

    // First: try pattern-matched retrieval (semantic + TF-IDF).
    let sections = await retrieveSectionsV2(genomeRoot, pattern, 4000);
    let wasCoreFallback = false;

    if (sections.length === 0) {
      // Pattern scored 0 against all genome sections (expected for code-symbol
      // patterns against a project-knowledge genome). Fall back to core sections
      // (empty-query path in retrieveSections) — these are the actual bytes the
      // real grep tool returns for unmatched queries. This gives a real ratio
      // measurement rather than the synthetic rawBytes/4 estimate.
      sections = await retrieveSections(genomeRoot, "", 4000);
      wasCoreFallback = true;
    }

    if (sections.length === 0) return null;
    const formatted = formatGenomeForPrompt(sections);
    return { bytes: formatted.length, wasCoreFallback };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Synthetic fixture (used when no real workload is available)
// ---------------------------------------------------------------------------

/**
 * Build a synthetic workload that runs rg against the ashlr-plugin source
 * tree. These patterns are representative of typical agent queries.
 */
function syntheticWorkload(): Workload[] {
  // Use __dirname-equivalent: the directory of this script.
  const pluginRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
  return [
    { cwd: pluginRoot, pattern: "recordSaving" },
    { cwd: pluginRoot, pattern: "retrieveSectionsV2" },
    { cwd: pluginRoot, pattern: "genomeExists" },
    { cwd: pluginRoot, pattern: "spawnSync" },
    { cwd: pluginRoot, pattern: "estimateTokens" },
    { cwd: pluginRoot, pattern: "tokensSaved" },
    { cwd: pluginRoot, pattern: "formatBaseline" },
    { cwd: pluginRoot, pattern: "snipCompact" },
  ];
}

/**
 * Build a synthetic workload using only rg raw sizes (no genome required).
 * Used when genome isn't available — we still measure rg output sizes so the
 * calibration data is available for future use once a genome is created.
 *
 * In this mode we compute ratio = rawBytes / (rawBytes / 4) = 4.0 as a
 * passthrough. The sample is flagged quality="synthetic" so callers can
 * detect and warn about the bogus estimate.
 */
function syntheticSampleNoGenome(w: Workload, rawBytes: number): CalibrationSample {
  // Without a genome we can't compress, so we estimate compressed = raw/4.
  // quality="synthetic" lets the report warn about low-quality samples.
  const compressedBytes = Math.max(1, Math.round(rawBytes / 4));
  return {
    cwd: w.cwd,
    pattern: w.pattern,
    rawBytes,
    compressedBytes,
    ratio: rawBytes / compressedBytes,
    quality: "synthetic",
  };
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx]!;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderReport(
  samples: CalibrationSample[],
  meanRatio: number,
  p50: number,
  p90: number,
  outPath: string,
  measuredMean?: number,
  syntheticMean?: number,
  measuredCount?: number,
  coreFallbackMean?: number,
  coreFallbackCount?: number,
): string {
  const lines: string[] = [];
  lines.push("ashlr grep calibration report");
  lines.push("═".repeat(50));
  lines.push("");

  if (samples.length === 0) {
    lines.push("No samples collected. Check that rg is installed and patterns match files.");
    return lines.join("\n");
  }

  // Per-sample table
  lines.push("samples:");
  const hdr = "  pattern".padEnd(30) + "raw bytes".padEnd(12) + "compressed".padEnd(13) + "ratio".padEnd(9) + "quality";
  lines.push(hdr);
  lines.push("  " + "─".repeat(72));
  for (const s of samples) {
    const pat = s.pattern.slice(0, 26).padEnd(28);
    const raw = s.rawBytes.toLocaleString().padEnd(10);
    const comp = s.compressedBytes.toLocaleString().padEnd(11);
    const ratio = (s.ratio.toFixed(2) + "×").padEnd(7);
    const quality = s.quality ?? "synthetic";
    lines.push(`  ${pat}  ${raw}  ${comp}  ${ratio}  ${quality}`);
  }

  // Counts: prefer caller-supplied; otherwise derive from samples to stay
  // consistent with the per-sample quality flags.
  const cfCount = coreFallbackCount ?? samples.filter((s) => s.quality === "core-fallback").length;
  const synCount =
    samples.length - (measuredCount ?? samples.filter((s) => s.quality === "measured").length) - cfCount;
  const syntheticPct = ((synCount / samples.length) * 100).toFixed(0);

  lines.push("");
  lines.push("aggregate:");
  lines.push(`  samples        ${samples.length}`);
  if ((measuredCount ?? 0) > 0) {
    lines.push(`  measured       ${measuredCount ?? 0}  (pattern-matched genome retrieval)`);
  }
  if (cfCount > 0) {
    lines.push(`  core-fallback  ${cfCount}  (no pattern match — constant core-section output)`);
  }
  if (synCount > 0) {
    lines.push(`  synthetic      ${synCount}  (${syntheticPct}% — 4× estimate, no genome present)`);
  }
  if ((measuredCount ?? 0) > 0 && measuredMean !== undefined) {
    lines.push(`  measuredMean   ${measuredMean.toFixed(2)}×  ← used by efficiency-server`);
  }
  if (cfCount > 0 && coreFallbackMean !== undefined) {
    lines.push(`  coreFbMean     ${coreFallbackMean.toFixed(2)}×`);
  }
  if (synCount > 0 && syntheticMean !== undefined) {
    lines.push(`  syntheticMean  ${syntheticMean.toFixed(2)}×`);
  }
  lines.push(`  overallMean    ${meanRatio.toFixed(2)}×`);
  lines.push(`  p50            ${p50.toFixed(2)}×`);
  lines.push(`  p90            ${p90.toFixed(2)}×`);

  if (synCount > 0 && synCount > (samples.length / 2)) {
    lines.push("");
    lines.push(
      `  WARNING: ${syntheticPct}% of samples are synthetic (no genome match). ` +
      `Run /ashlr-genome-init to index this project's code for real measurements.`,
    );
  }
  if (cfCount > 0 && (measuredCount ?? 0) === 0) {
    lines.push("");
    lines.push(
      `  NOTE: every genome-engaged sample fell to core-fallback. The mean ratio ` +
      `reflects ashlr__grep behavior on non-matching queries, not pattern-specific ` +
      `compression. Refresh the genome to improve pattern match rates.`,
    );
  }

  lines.push("");
  lines.push(`written → ${outPath}`);
  lines.push("");
  lines.push(
    `To activate: efficiency-server will read this file automatically on next start.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  workloadPath?: string;
  outPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  let workloadPath: string | undefined;
  let outPath = join(homedir(), ".ashlr", "calibration.json");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--workload" || a === "-w") && argv[i + 1]) {
      workloadPath = argv[++i];
    } else if ((a === "--out" || a === "-o") && argv[i + 1]) {
      outPath = argv[++i];
    }
  }
  return { workloadPath, outPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runCalibration(opts: {
  workloadPath?: string;
  outPath?: string;
}): Promise<CalibrationFile> {
  const outPath = opts.outPath ?? join(homedir(), ".ashlr", "calibration.json");

  // 1. Load workload
  let workloads: Workload[];
  const defaultWorkloadPath = join(homedir(), ".ashlr", "calibration-workload.jsonl");

  const resolvedWorkloadPath = opts.workloadPath ?? (existsSync(defaultWorkloadPath) ? defaultWorkloadPath : null);
  if (resolvedWorkloadPath && existsSync(resolvedWorkloadPath)) {
    const raw = readFileSync(resolvedWorkloadPath, "utf-8");
    workloads = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Workload);
    process.stdout.write(`Loaded ${workloads.length} workload(s) from ${resolvedWorkloadPath}\n`);
  } else {
    workloads = syntheticWorkload();
    process.stdout.write(`No workload file found — using ${workloads.length} synthetic fixture(s)\n`);
  }

  // 2. Run each workload
  const samples: CalibrationSample[] = [];
  process.stdout.write(`\nRunning calibration against ${workloads.length} pattern(s)...\n`);

  for (const w of workloads) {
    const cwdAbs = resolve(w.cwd);
    process.stdout.write(`  rg ${JSON.stringify(w.pattern)} in ${cwdAbs} ... `);

    const rawBytes = rgRawBytes(w.pattern, cwdAbs);
    if (rawBytes === null) {
      process.stdout.write("rg unavailable, skipped\n");
      continue;
    }
    if (rawBytes === 0) {
      process.stdout.write("no matches, skipped\n");
      continue;
    }

    // Try genome path first
    const genomeResult = await genomeCompressedBytes(w.pattern, cwdAbs);
    if (genomeResult !== null && genomeResult.bytes > 0) {
      const { bytes: compressedBytes, wasCoreFallback } = genomeResult;
      const ratio = rawBytes / compressedBytes;
      const qualityNote = wasCoreFallback ? " (core-fallback)" : "";
      samples.push({
        cwd: cwdAbs,
        pattern: w.pattern,
        rawBytes,
        compressedBytes,
        ratio,
        quality: wasCoreFallback ? "core-fallback" : "measured",
      });
      process.stdout.write(
        `raw=${rawBytes} compressed=${compressedBytes} ratio=${ratio.toFixed(2)}×${qualityNote}\n`,
      );
    } else {
      // No genome — use synthetic estimate so we still have a data point
      const s = syntheticSampleNoGenome(w, rawBytes);
      samples.push(s);
      process.stdout.write(`raw=${rawBytes} (no genome, estimated ratio=${s.ratio.toFixed(2)}×)\n`);
    }
  }

  // 3. Compute stats — split measured / core-fallback / synthetic. "measured"
  // is reserved for pattern-matched genome retrievals; core-fallback samples
  // reflect real ashlr__grep behavior for non-matching queries but their
  // ratio is dominated by a constant numerator, so we surface them
  // separately rather than letting them inflate `measuredMean`.
  const measuredSamples = samples.filter((s) => s.quality === "measured");
  const coreFallbackSamples = samples.filter((s) => s.quality === "core-fallback");
  const syntheticSamples = samples.filter((s) => s.quality === "synthetic");

  const allRatios = samples.map((s) => s.ratio).sort((a, b) => a - b);
  const measuredRatios = measuredSamples.map((s) => s.ratio);
  const coreFallbackRatios = coreFallbackSamples.map((s) => s.ratio);
  const syntheticRatios = syntheticSamples.map((s) => s.ratio);

  const meanRatio = mean(allRatios);
  const measuredMean = measuredRatios.length > 0 ? mean(measuredRatios) : undefined;
  const coreFallbackMean = coreFallbackRatios.length > 0 ? mean(coreFallbackRatios) : undefined;
  const syntheticMean = syntheticRatios.length > 0 ? mean(syntheticRatios) : undefined;
  const p50 = percentile(allRatios, 50);
  const p90 = percentile(allRatios, 90);

  // 4. Write calibration.json
  const result: CalibrationFile = {
    updatedAt: new Date().toISOString(),
    samples,
    meanRatio: samples.length > 0 ? meanRatio : 4,
    p50: samples.length > 0 ? p50 : 4,
    p90: samples.length > 0 ? p90 : 4,
    measuredMean,
    syntheticMean,
    measuredCount: measuredSamples.length,
    coreFallbackMean,
    coreFallbackCount: coreFallbackSamples.length,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  // 5. Print report
  process.stdout.write(
    "\n" +
      renderReport(
        samples,
        result.meanRatio,
        result.p50,
        result.p90,
        outPath,
        measuredMean,
        syntheticMean,
        measuredSamples.length,
        coreFallbackMean,
        coreFallbackSamples.length,
      ) +
      "\n",
  );

  return result;
}

// Exported for tests
export { percentile, mean, renderReport, syntheticWorkload, syntheticSampleNoGenome };

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  await runCalibration({ workloadPath: args.workloadPath, outPath: args.outPath });
}
