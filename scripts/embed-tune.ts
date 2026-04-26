#!/usr/bin/env bun
/**
 * embed-tune.ts — Threshold tuner for the embedding cache.
 *
 * Reads ~/.ashlr/embed-calibration.jsonl (written by servers/_embed-calibration.ts
 * on every grep call) and sweeps cosine similarity thresholds to find the
 * value that maximises F1 (or a user-weighted F-beta variant).
 *
 * Usage:
 *   bun run scripts/embed-tune.ts
 *   bun run scripts/embed-tune.ts --input ~/.ashlr/embed-calibration.jsonl
 *   bun run scripts/embed-tune.ts --weight precision=2   # penalise false-positives
 *   bun run scripts/embed-tune.ts --apply               # write to ~/.ashlr/config.json
 *
 * Output (stdout):
 *   current threshold 0.68 → precision 0.72  recall 0.81
 *   recommended       0.71 → precision 0.78  recall 0.76  F1 0.77
 *   Set via ASHLR_EMBED_THRESHOLD=0.71 or use --apply to persist.
 *
 * With --apply, writes embedThreshold to ~/.ashlr/config.json and prints
 * "restart Claude Code to apply".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalibrationEntry {
  ts: string;
  queryHashHex: string;
  topSimilarity: number;
  /** true = the cached result was used (hit); false = skipped (miss) */
  hit: boolean;
  contentLength: number;
  threshold: number;
}

export interface ThresholdStats {
  threshold: number;
  /** fraction of queries that would be served from cache */
  recall: number;
  /**
   * of those served from cache, fraction that were genuinely "good" hits
   * (defined as: original hit=true at any threshold, i.e. high-quality match).
   * When all calibration data was recorded at the same threshold, we treat
   * "hit=true" as ground-truth positive.
   */
  precision: number;
  /** F-beta score combining precision and recall */
  fBeta: number;
}

export interface TuneResult {
  currentThreshold: number;
  currentStats: ThresholdStats;
  recommendedThreshold: number;
  recommendedStats: ThresholdStats;
  allStats: ThresholdStats[];
  betaWeight: number;
  entryCount: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function defaultCalibPath(): string {
  return join(process.env.HOME ?? homedir(), ".ashlr", "embed-calibration.jsonl");
}

function defaultConfigPath(): string {
  return join(process.env.HOME ?? homedir(), ".ashlr", "config.json");
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export function loadCalibrationEntries(inputPath: string): CalibrationEntry[] {
  if (!existsSync(inputPath)) return [];
  const lines = readFileSync(inputPath, "utf-8").split("\n").filter((l) => l.trim());
  const entries: CalibrationEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as CalibrationEntry);
    } catch {
      // Skip malformed lines.
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Core sweep algorithm
// ---------------------------------------------------------------------------

/**
 * For a given threshold, compute precision and recall.
 *
 * Ground truth:
 *   - "Positive" = the original calibration record had hit=true (the cached
 *     result was actually used). These are the genuinely useful retrievals.
 *   - At a swept threshold T, a query "would hit" iff topSimilarity >= T.
 *
 * Definitions:
 *   recall    = |{would hit at T} ∩ {ground-truth positive}| / |{ground-truth positive}|
 *               i.e. fraction of real hits we'd serve from cache
 *   precision = |{would hit at T} ∩ {ground-truth positive}| / |{would hit at T}|
 *               i.e. fraction of cache hits that are genuine
 *
 * When |{would hit at T}| = 0, precision is defined as 1.0 (no false positives).
 * When |{ground-truth positive}| = 0, recall is 0.
 */
export function computeStats(
  entries: CalibrationEntry[],
  threshold: number,
  betaWeight: number,
): ThresholdStats {
  const totalPositives = entries.filter((e) => e.hit).length;
  const wouldHit = entries.filter((e) => e.topSimilarity >= threshold);
  const truePositives = wouldHit.filter((e) => e.hit).length;

  const precision = wouldHit.length === 0 ? 1.0 : truePositives / wouldHit.length;
  const recall = totalPositives === 0 ? 0 : truePositives / totalPositives;

  // F-beta: (1 + beta^2) * P * R / (beta^2 * P + R)
  const beta2 = betaWeight * betaWeight;
  const fBeta =
    precision + recall === 0
      ? 0
      : ((1 + beta2) * precision * recall) / (beta2 * precision + recall);

  return { threshold, precision, recall, fBeta };
}

/**
 * Sweep thresholds from 0.50 → 0.95 in 0.01 steps.
 * Returns stats for every step, sorted ascending by threshold.
 */
export function sweepThresholds(
  entries: CalibrationEntry[],
  betaWeight: number,
): ThresholdStats[] {
  const results: ThresholdStats[] = [];
  for (let t = 50; t <= 95; t++) {
    const threshold = t / 100;
    results.push(computeStats(entries, threshold, betaWeight));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main tuner logic
// ---------------------------------------------------------------------------

export function tune(
  entries: CalibrationEntry[],
  currentThreshold: number,
  betaWeight: number,
): TuneResult {
  const allStats = sweepThresholds(entries, betaWeight);

  // Pick the threshold with the highest F-beta.
  const best = allStats.reduce((a, b) => (b.fBeta > a.fBeta ? b : a));

  // Stats at the current threshold (nearest 0.01 step).
  const currentRounded = Math.round(currentThreshold * 100) / 100;
  const currentStats =
    allStats.find((s) => Math.abs(s.threshold - currentRounded) < 0.001) ??
    computeStats(entries, currentThreshold, betaWeight);

  return {
    currentThreshold,
    currentStats,
    recommendedThreshold: best.threshold,
    recommendedStats: best,
    allStats,
    betaWeight,
    entryCount: entries.length,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toFixed(2);
}

export function renderReport(result: TuneResult): string {
  const lines: string[] = [];

  lines.push("ashlr embed-tune report");
  lines.push("─".repeat(50));
  lines.push(`  entries analysed : ${result.entryCount}`);
  lines.push(`  beta weight      : ${result.betaWeight} (F${result.betaWeight} score)`);
  lines.push("");

  if (result.entryCount === 0) {
    lines.push("  No calibration data found.");
    lines.push("  Run some grep operations via ashlr to populate ~/.ashlr/embed-calibration.jsonl");
    return lines.join("\n");
  }

  const c = result.currentStats;
  const r = result.recommendedStats;

  lines.push(
    `  current threshold  ${fmt(result.currentThreshold)}` +
      `  →  precision ${fmt(c.precision)}  recall ${fmt(c.recall)}  F${result.betaWeight} ${fmt(c.fBeta)}`,
  );
  lines.push(
    `  recommended        ${fmt(r.threshold)}` +
      `  →  precision ${fmt(r.precision)}  recall ${fmt(r.recall)}  F${result.betaWeight} ${fmt(r.fBeta)}`,
  );
  lines.push("");

  const delta = r.threshold - result.currentThreshold;
  if (Math.abs(delta) < 0.005) {
    lines.push("  Current threshold is already optimal.");
  } else {
    lines.push(
      `  Set via: ASHLR_EMBED_THRESHOLD=${fmt(r.threshold)}`,
    );
    lines.push(`  Or run with --apply to persist to ~/.ashlr/config.json`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Config persistence (--apply)
// ---------------------------------------------------------------------------

export function applyThreshold(threshold: number, configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  existing.embedThreshold = threshold;
  writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  input: string;
  betaWeight: number;
  apply: boolean;
  configPath: string;
} {
  let input = defaultCalibPath();
  let betaWeight = 1.0;
  let apply = false;
  let configPath = defaultConfigPath();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" && argv[i + 1]) {
      input = argv[++i];
    } else if (arg === "--weight" && argv[i + 1]) {
      // Accept formats: "precision=2" or "2" or "recall=0.5"
      const raw = argv[++i];
      const match = raw.match(/(?:precision|recall)?=?(\d+(?:\.\d+)?)/);
      if (match) betaWeight = parseFloat(match[1]);
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--config" && argv[i + 1]) {
      configPath = argv[++i];
    }
  }

  return { input, betaWeight, apply, configPath };
}

if (import.meta.main) {
  const { input, betaWeight, apply, configPath } = parseArgs(process.argv.slice(2));

  const EMBED_HIT_THRESHOLD = (() => {
    const raw = process.env.ASHLR_EMBED_THRESHOLD;
    if (!raw) return 0.68;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.68;
  })();

  const entries = loadCalibrationEntries(input);
  const result = tune(entries, EMBED_HIT_THRESHOLD, betaWeight);
  console.log(renderReport(result));

  if (apply && entries.length > 0) {
    const t = result.recommendedThreshold;
    applyThreshold(t, configPath);
    console.log(`\nWrote embedThreshold=${t} to ${configPath}`);
    console.log("Restart Claude Code to apply.");
  }
}
