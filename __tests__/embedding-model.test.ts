/**
 * Tests for servers/_embedding-model.ts
 *
 * Validates BM25 pseudo-embedding properties:
 *   - Determinism: same input → same vector
 *   - High cosine for similar inputs
 *   - Low cosine for dissimilar inputs
 *   - Unit-norm output
 *   - Correct dimension
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { bm25Embed, tokenize, EMBED_DIM, upsertCorpus } from "../servers/_embedding-model";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

// Seed corpus with a few docs so IDF weights are non-trivial.
beforeAll(() => {
  upsertCorpus("function embed text tokenize hash projection vector cosine similarity");
  upsertCorpus("database sqlite insert select upsert blob float32array embedding dim");
  upsertCorpus("http fetch json model ollama remote endpoint fallback bm25");
});

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  test("lowercases and splits on punctuation", () => {
    const tokens = tokenize("Hello, World! foo_bar.baz");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
    expect(tokens).toContain("foo_bar");
    expect(tokens).toContain("baz");
  });

  test("empty string → empty array", () => {
    expect(tokenize("")).toEqual([]);
  });

  test("numbers are kept", () => {
    const tokens = tokenize("dim=256 version2");
    expect(tokens).toContain("dim");
    expect(tokens).toContain("256");
    expect(tokens).toContain("version2");
  });
});

// ---------------------------------------------------------------------------
// BM25 embed: dimension & unit norm
// ---------------------------------------------------------------------------

describe("bm25Embed — dimension and norm", () => {
  test("returns Float32Array of length EMBED_DIM", () => {
    const v = bm25Embed("some text about embeddings");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(EMBED_DIM);
  });

  test("output is unit-normalized (‖v‖ ≈ 1)", () => {
    const v = bm25Embed("normalize test vector output unit length");
    const n = norm(v);
    expect(n).toBeCloseTo(1.0, 5);
  });

  test("all-whitespace / no tokens → zero vector (norm=0 ok)", () => {
    // Edge case: tokenize returns [] → vec stays zero → normalizeInPlace is a no-op
    const v = bm25Embed("   \t\n  ");
    expect(v.length).toBe(EMBED_DIM);
    // norm can be 0 for empty input — just check no NaN
    for (let i = 0; i < v.length; i++) {
      expect(Number.isNaN(v[i])).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("bm25Embed — determinism", () => {
  test("same input produces identical Float32Array", () => {
    const text = "deterministic embedding test for ashlr grep cache";
    const v1 = bm25Embed(text);
    const v2 = bm25Embed(text);
    expect(v1.length).toBe(v2.length);
    for (let i = 0; i < v1.length; i++) {
      expect(v1[i]).toBe(v2[i]);
    }
  });

  test("different inputs produce different vectors", () => {
    const v1 = bm25Embed("sqlite database embedding cache storage");
    const v2 = bm25Embed("typescript function async await promise");
    let allSame = true;
    for (let i = 0; i < v1.length; i++) {
      if (v1[i] !== v2[i]) { allSame = false; break; }
    }
    expect(allSame).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cosine similarity: similar vs dissimilar
// ---------------------------------------------------------------------------

describe("bm25Embed — cosine similarity", () => {
  test("identical texts → cosine ≈ 1.0", () => {
    const text = "embedding model bm25 hash projection cosine similarity";
    const v1 = bm25Embed(text);
    const v2 = bm25Embed(text);
    const sim = cosineSim(v1, v2);
    expect(sim).toBeCloseTo(1.0, 5);
  });

  test("highly similar texts → cosine > 0.5", () => {
    const v1 = bm25Embed("embed text tokens idf weights bm25 projection");
    const v2 = bm25Embed("embed text tokens idf weights bm25 hash dim");
    const sim = cosineSim(v1, v2);
    expect(sim).toBeGreaterThan(0.5);
  });

  test("dissimilar texts → cosine < 0.4", () => {
    // Completely different domains: SQL schema vs HTTP routing
    const v1 = bm25Embed("create table embeddings blob float32 project hash section path");
    const v2 = bm25Embed("fetch post json response header authorization bearer token");
    const sim = cosineSim(v1, v2);
    expect(sim).toBeLessThan(0.4);
  });

  test("query near one document ranks higher than unrelated", () => {
    const query = bm25Embed("sqlite upsert embedding cosine search");
    const relevant = bm25Embed("sqlite insert select upsert embedding cosine similarity ranking");
    const irrelevant = bm25Embed("http fetch json ollama model endpoint bearer auth");

    const simRelevant = cosineSim(query, relevant);
    const simIrrelevant = cosineSim(query, irrelevant);
    expect(simRelevant).toBeGreaterThan(simIrrelevant);
  });
});

// ---------------------------------------------------------------------------
// EMBED_DIM constant
// ---------------------------------------------------------------------------

describe("EMBED_DIM", () => {
  test("is 256", () => {
    expect(EMBED_DIM).toBe(256);
  });
});
