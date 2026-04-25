/**
 * embed-remote-roundtrip.test.ts
 *
 * Verifies that `_embedding-model.ts::embed()` correctly routes through
 * ASHLR_EMBED_URL when set, and that the embedding cache (ContextDb) still
 * applies threshold gating and returns results when the remote path is live.
 *
 * Strategy:
 *   1. Spin up a tiny Bun.serve mock embedding server on a random port.
 *   2. Set ASHLR_EMBED_URL to that port.
 *   3. Insert N=20 documents into a fresh in-memory ContextDb using embed().
 *   4. Run one similarity query using embed().
 *   5. Assert: mock saw exactly N+1 POST requests (N inserts + 1 query).
 *   6. Assert: searchSimilar returns results with similarity > 0.
 *   7. Clean up: stop mock server, unset ASHLR_EMBED_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { embed, normalizeInPlace } from "../servers/_embedding-model";
import { openContextDb } from "../servers/_embedding-cache";

// ---------------------------------------------------------------------------
// Mock embedding server
// ---------------------------------------------------------------------------

const N_DOCS = 20;
const EMBED_DIM = 64; // small fixed dim for test speed

/** Track how many POST requests the mock received. */
let mockRequestCount = 0;
let mockServer: ReturnType<typeof Bun.serve> | null = null;
let mockPort = 0;
const originalEmbedUrl = process.env["ASHLR_EMBED_URL"];

/**
 * Generate a deterministic pseudo-embedding for a string.
 * Uses a simple hash so similar strings get similar vectors,
 * satisfying the round-trip test without an ML model.
 */
function mockEmbedding(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % EMBED_DIM]! += code / 127.0;
  }
  // Normalize
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return mag === 0 ? vec : vec.map((v) => v / mag);
}

beforeAll(() => {
  // Start the mock server on OS-assigned port (port 0)
  mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.method === "POST") {
        mockRequestCount++;
        return req.json().then((body: { prompt?: string; input?: string }) => {
          const text = body.prompt ?? body.input ?? "";
          const embedding = mockEmbedding(text);
          return new Response(JSON.stringify({ embedding }), {
            headers: { "Content-Type": "application/json" },
          });
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  mockPort = mockServer.port ?? 0;
  process.env["ASHLR_EMBED_URL"] = `http://localhost:${mockPort}/api/embeddings`;
});

afterAll(() => {
  mockServer?.stop(true);
  if (originalEmbedUrl === undefined) {
    delete process.env["ASHLR_EMBED_URL"];
  } else {
    process.env["ASHLR_EMBED_URL"] = originalEmbedUrl;
  }
});

// ---------------------------------------------------------------------------
// Round-trip test
// ---------------------------------------------------------------------------

describe("embed() remote round-trip via ASHLR_EMBED_URL", () => {
  test(`N=${N_DOCS} inserts + 1 query → mock sees N+1 requests, results returned`, async () => {
    // Fresh in-memory ContextDb (ASHLR_CONTEXT_DB_DISABLE not set; use temp home)
    const { tmpdir } = await import("os");
    const { mkdtemp, rm } = await import("fs/promises");
    const { join } = await import("path");

    const tmpHome = await mkdtemp(join(tmpdir(), "ashlr-embed-rt-"));
    try {
      const db = openContextDb(tmpHome);
      const projectHash = "test-proj-abc123";

      // Reset counter before this test
      mockRequestCount = 0;

      // Insert N documents — each calls embed() which should hit the remote
      const docs = Array.from({ length: N_DOCS }, (_, i) => ({
        path: `docs/section-${i}.md`,
        text: `Section ${i}: discusses embedding models, cosine similarity, and retrieval strategies for code search index ${i}.`,
      }));

      for (const doc of docs) {
        const embedding = await embed(doc.text);
        // Verify we got a non-zero vector from the remote
        expect(embedding.length).toBeGreaterThan(0);
        expect(Array.from(embedding).some((v) => v !== 0)).toBe(true);

        db.upsertEmbedding({
          projectHash,
          sectionPath: doc.path,
          sectionText: doc.text,
          embedding,
          embeddingDim: embedding.length,
          source: "doc",
        });
      }

      // Issue one similarity query — this also calls embed()
      const queryText = "embedding model cosine similarity code search";
      const queryEmbedding = await embed(queryText);

      const results = db.searchSimilar({
        projectHash,
        embedding: queryEmbedding,
        limit: 5,
      });

      // --- Assertions -------------------------------------------------------

      // 1. Mock saw exactly N + 1 POST requests (N inserts + 1 query)
      expect(mockRequestCount).toBe(N_DOCS + 1);

      // 2. Results were returned (threshold tuning still applied — we just need ≥1)
      expect(results.length).toBeGreaterThanOrEqual(1);

      // 3. Results have positive similarity scores
      for (const r of results) {
        expect(r.similarity).toBeGreaterThan(0);
      }

      // 4. Results are sorted descending by similarity
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.similarity).toBeGreaterThanOrEqual(results[i]!.similarity);
      }
    } finally {
      await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("fallback to BM25 when ASHLR_EMBED_URL is unset", async () => {
    const saved = process.env["ASHLR_EMBED_URL"];
    delete process.env["ASHLR_EMBED_URL"];
    try {
      const v = await embed("fallback test using bm25 hash projection");
      expect(v.length).toBe(256); // BM25_DIM is 256
      expect(Array.from(v).some((x) => x !== 0)).toBe(true);
    } finally {
      process.env["ASHLR_EMBED_URL"] = saved;
    }
  });

  test("mock server down → graceful fallback to BM25", async () => {
    // Point to a port that won't respond
    const saved = process.env["ASHLR_EMBED_URL"];
    process.env["ASHLR_EMBED_URL"] = "http://localhost:1/unreachable";
    try {
      // embed() should fall back silently to BM25 (no throw)
      const v = await embed("graceful fallback test");
      expect(v.length).toBe(256); // BM25_DIM — confirms BM25 fallback
    } finally {
      process.env["ASHLR_EMBED_URL"] = saved;
    }
  });
});
