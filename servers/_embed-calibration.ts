/**
 * _embed-calibration — embedding threshold constants and calibration helpers.
 *
 * Used by grep-server to gate the embedding cache and log A/B data so we
 * can tune EMBED_HIT_THRESHOLD from real usage instead of guesses.
 */

import { createHash } from "crypto";

/**
 * Cosine similarity threshold for a cache hit to prepend results.
 *
 * Baseline 0.68 (down from 0.75 in v1.12) — calibrated against the 24-doc
 * BM25 corpus where IDF weights are nearly flat and real similarity scores
 * cluster lower than classic dense-embedding expectations. Override via
 * `ASHLR_EMBED_THRESHOLD` (float in [0, 1]). A/B data flows to
 * `~/.ashlr/embed-calibration.jsonl` (see recordEmbedCalibration below).
 */
export const EMBED_HIT_THRESHOLD = (() => {
  const raw = process.env.ASHLR_EMBED_THRESHOLD;
  if (!raw) return 0.68;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.68;
})();

/**
 * Minimum BM25 corpus size before the embedding cache is consulted. Below
 * this threshold, IDF weights are dominated by noise and nearly any query
 * produces a spurious hit — see v1.17 incident where a 6-doc corpus emitted
 * 0.7+ cosine hits on unrelated patterns.
 *
 * v1.18 Trust Pass: if docCount < THIS, the cache is skipped outright.
 * Reads `~/.ashlr/embed-corpus.json` directly (the writer lives in
 * `_embedding-model.ts`) so we don't have to export a new function.
 */
export const BM25_CORPUS_MIN = 50;

/** Stable 8-char project hash from absolute cwd path. */
export function projectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 8);
}

export function readCorpusDocCount(): number {
  try {
    const { readFileSync, existsSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const { homedir } = require("os") as typeof import("os");
    const p = join(process.env.HOME ?? homedir(), ".ashlr", "embed-corpus.json");
    if (!existsSync(p)) return 0;
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as { docCount?: number };
    return typeof parsed.docCount === "number" && Number.isFinite(parsed.docCount) ? parsed.docCount : 0;
  } catch {
    return 0;
  }
}

// Lightweight calibration log so we can tune EMBED_HIT_THRESHOLD from real
// data instead of guesses. Appends one JSONL record per grep call; fire-and-forget.
export async function recordEmbedCalibration(record: {
  queryHashHex: string;
  topSimilarity: number;
  hit: boolean;
  contentLength: number;
  threshold: number;
}): Promise<void> {
  try {
    const { homedir } = await import("os");
    const { appendFile, mkdir } = await import("fs/promises");
    const { dirname, join } = await import("path");
    const path = join(process.env.HOME ?? homedir(), ".ashlr", "embed-calibration.jsonl");
    await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    await appendFile(path, line, "utf-8");
  } catch {
    // Calibration log is observability, not critical path.
  }
}
