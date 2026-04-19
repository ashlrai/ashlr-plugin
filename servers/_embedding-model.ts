/**
 * _embedding-model.ts — Pluggable embedder for the ashlr embedding cache.
 *
 * Day-1 strategy: BM25-style sparse pseudo-embedding via hash projection.
 *   - Tokenize input text (whitespace + punctuation split, lowercase).
 *   - Compute per-token IDF weights from a per-project corpus stored at
 *     ~/.ashlr/embed-corpus.json.
 *   - Project token TF-IDF scores into a fixed 256-dim vector via a
 *     deterministic hash (FNV-1a → index mod 256, sign from bit 0).
 *   - Normalize to unit length before returning.
 *
 * This gives useful cosine similarity WITHOUT any ML runtime:
 *   - Same input → same vector (deterministic).
 *   - Similar inputs (shared tokens) → high cosine.
 *   - Dissimilar inputs → low cosine.
 *
 * Remote embedding (optional):
 *   Set ASHLR_EMBED_URL=http://localhost:11434/api/embeddings to call an
 *   Ollama/LM Studio endpoint. Falls back to BM25 on any failure.
 *
 * Env vars:
 *   ASHLR_EMBED_URL          — HTTP POST endpoint that returns { embedding: number[] }
 *   ASHLR_EMBED_MODEL        — model name to pass in the request body (default: nomic-embed-text)
 *   ASHLR_CONTEXT_DB_DISABLE — if "1", embed() still works (used outside the cache path)
 */

import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed output dimension for the BM25 hash-projection embedder. */
export const EMBED_DIM = 256;

/** Max tokens considered per document (cap to keep hashing O(1) on huge files). */
const MAX_TOKENS = 2048;

/** IDF corpus path. */
const corpusPath = (): string =>
  join(homedir(), ".ashlr", "embed-corpus.json");

/** Minimum document frequency count before IDF kicks in (avoids div-by-0 on tiny corpus). */
const MIN_DF = 1;

// ---------------------------------------------------------------------------
// Corpus (IDF weights)
// ---------------------------------------------------------------------------

interface Corpus {
  /** document count (each upsertCorpus call = 1 doc) */
  docCount: number;
  /** token → document frequency */
  df: Record<string, number>;
}

let _corpus: Corpus | null = null;

function loadCorpus(): Corpus {
  if (_corpus) return _corpus;
  const path = corpusPath();
  if (existsSync(path)) {
    try {
      _corpus = JSON.parse(readFileSync(path, "utf-8")) as Corpus;
      return _corpus;
    } catch {
      // corrupt; reinitialize
    }
  }
  _corpus = { docCount: 0, df: {} };
  return _corpus;
}

function saveCorpus(c: Corpus): void {
  const path = corpusPath();
  const dir = join(homedir(), ".ashlr");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(c), "utf-8");
}

/**
 * Update the IDF corpus with tokens from a new document.
 * Call this when indexing new content so IDF weights improve over time.
 * Fire-and-forget safe (synchronous, but cheap).
 */
export function upsertCorpus(text: string): void {
  const c = loadCorpus();
  const tokens = tokenize(text);
  const seen = new Set(tokens);
  c.docCount += 1;
  for (const t of seen) {
    c.df[t] = (c.df[t] ?? 0) + 1;
  }
  _corpus = c;
  // Persist async so callers never block. Use setImmediate to defer past the
  // current call stack (fire-and-forget).
  setImmediate(() => {
    try { saveCorpus(c); } catch { /* best-effort */ }
  });
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

const TOKEN_RE = /[a-z0-9_$]+/g;

/** Tokenize text: lowercase, extract alphanumeric+underscore runs. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).slice(0, MAX_TOKENS);
}

// ---------------------------------------------------------------------------
// FNV-1a hash projection
// ---------------------------------------------------------------------------

/**
 * Deterministic hash of a string → integer in [0, EMBED_DIM).
 * Uses FNV-1a 32-bit: fast, no deps, uniform-ish distribution.
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0; // unsigned
}

/** Map a token to a bucket index [0, EMBED_DIM) and a sign (+1 or -1). */
function tokenToProjection(token: string): { idx: number; sign: number } {
  const h = fnv1a(token);
  const idx = h % EMBED_DIM;
  const sign = (h & 1) === 0 ? 1 : -1;
  return { idx, sign };
}

// ---------------------------------------------------------------------------
// BM25-style pseudo-embedding (local, no ML runtime)
// ---------------------------------------------------------------------------

/**
 * Build a 256-dim BM25 pseudo-embedding for the given text.
 * Uses TF × IDF weights projected via FNV-1a hash.
 * Returns a normalized Float32Array.
 */
export function bm25Embed(text: string): Float32Array {
  const corpus = loadCorpus();
  const tokens = tokenize(text);
  const N = Math.max(corpus.docCount, 1);

  // TF: raw count
  const tf: Record<string, number> = {};
  for (const t of tokens) {
    tf[t] = (tf[t] ?? 0) + 1;
  }

  const vec = new Float32Array(EMBED_DIM);

  for (const [token, count] of Object.entries(tf)) {
    const df = Math.max(corpus.df[token] ?? 0, MIN_DF);
    // IDF: log((N + 1) / (df + 1)) — smoothed BM25-style
    const idf = Math.log((N + 1) / (df + 1)) + 1;
    const weight = count * idf;
    const { idx, sign } = tokenToProjection(token);
    vec[idx] += sign * weight;
  }

  return normalizeInPlace(vec);
}

// ---------------------------------------------------------------------------
// Remote embedder (Ollama / LM Studio)
// ---------------------------------------------------------------------------

/**
 * Call a remote embedding endpoint.
 * Returns null on any failure so the caller can fall back to BM25.
 */
async function remoteEmbed(text: string): Promise<Float32Array | null> {
  const url = process.env.ASHLR_EMBED_URL;
  if (!url) return null;

  const model = process.env.ASHLR_EMBED_MODEL ?? "nomic-embed-text";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      // 5-second timeout — don't block the grep path
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(json.embedding)) return null;

    const vec = new Float32Array(json.embedding);
    return normalizeInPlace(vec);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Normalization helper
// ---------------------------------------------------------------------------

function normalizeInPlace(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const mag = Math.sqrt(sum);
  if (mag === 0) return v;
  for (let i = 0; i < v.length; i++) v[i]! /= mag;
  return v;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute an embedding for the given text.
 *
 * Strategy:
 *   1. If ASHLR_EMBED_URL is set, try the remote endpoint.
 *   2. On failure (or no URL), fall back to BM25 pseudo-embedding.
 *
 * The returned Float32Array is already normalized to unit length.
 */
export async function embed(text: string): Promise<Float32Array> {
  if (process.env.ASHLR_EMBED_URL) {
    const remote = await remoteEmbed(text);
    if (remote) return remote;
    // Fall through to BM25 on failure
  }
  return bm25Embed(text);
}

/**
 * The dimension of the vector returned by `embed()`.
 * When using a remote model this may differ — callers should use
 * the actual vector length; this constant applies only to BM25.
 */
export { EMBED_DIM as BM25_DIM };
