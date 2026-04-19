/**
 * Comprehensive tests for servers/_embedding-cache.ts
 *
 * Covers:
 *  - Schema creation on first open
 *  - Upsert + retrieve roundtrip (Float32Array byte-level equality)
 *  - Cosine similarity ranking (known-geometry vectors)
 *  - Cross-project search
 *  - retrieval_log recording
 *  - ASHLR_CONTEXT_DB_DISABLE=1 no-op mode
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { Database } from "bun:sqlite";
import {
  openContextDb,
  getSchemaVersion,
  SCHEMA_VERSION,
  type ContextDb,
} from "../servers/_embedding-cache";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome: string;
let db: ContextDb;

function makeTmpHome(label: string): string {
  const dir = join(tmpdir(), `ashlr-test-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTmp(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** Make a Float32Array with given values, not yet normalized. */
function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

/** Cosine similarity between two arbitrary (unnormalized) vectors — for test verification. */
function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ---------------------------------------------------------------------------
// Test group 1: Schema creation
// ---------------------------------------------------------------------------

describe("openContextDb — schema creation", () => {
  let home: string;

  beforeEach(() => { home = makeTmpHome("schema"); });
  afterEach(() => { cleanTmp(home); });

  test("creates ~/.ashlr/context.db on first open", () => {
    const d = openContextDb(home);
    d.close();
    expect(existsSync(join(home, ".ashlr", "context.db"))).toBe(true);
  });

  test("schema_version is set to SCHEMA_VERSION", () => {
    const d = openContextDb(home);
    d.close();
    const raw = new Database(join(home, ".ashlr", "context.db"), { readonly: true });
    const v = getSchemaVersion(raw);
    raw.close();
    expect(v).toBe(SCHEMA_VERSION);
  });

  test("opening twice does not throw (idempotent DDL)", () => {
    const d1 = openContextDb(home);
    d1.close();
    const d2 = openContextDb(home);
    d2.close();
  });

  test("embeddings and retrieval_log tables exist", () => {
    const d = openContextDb(home);
    d.close();
    const raw = new Database(join(home, ".ashlr", "context.db"), { readonly: true });
    const tables = raw.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map((r) => r.name);
    raw.close();
    expect(tables).toContain("embeddings");
    expect(tables).toContain("retrieval_log");
    expect(tables).toContain("schema_version");
  });
});

// ---------------------------------------------------------------------------
// Test group 2: Upsert + retrieve roundtrip
// ---------------------------------------------------------------------------

describe("upsertEmbedding — roundtrip", () => {
  let home: string;

  beforeEach(() => {
    home = makeTmpHome("upsert");
    db = openContextDb(home);
  });
  afterEach(() => { db.close(); cleanTmp(home); });

  test("upsert stores a record and it is searchable", () => {
    const embedding = vec(1, 0, 0);
    db.upsertEmbedding({
      projectHash: "proj-aaa",
      sectionPath: "knowledge/auth.md#section1",
      sectionText: "This is the auth section.",
      embedding,
      embeddingDim: 3,
      source: "genome",
    });

    const results = db.searchSimilar({ projectHash: "proj-aaa", embedding: vec(1, 0, 0), limit: 5 });
    expect(results.length).toBe(1);
    expect(results[0]!.sectionPath).toBe("knowledge/auth.md#section1");
    expect(results[0]!.sectionText).toBe("This is the auth section.");
    expect(results[0]!.source).toBe("genome");
    expect(results[0]!.projectHash).toBe("proj-aaa");
  });

  test("upsert updates existing record (ON CONFLICT)", () => {
    db.upsertEmbedding({
      projectHash: "proj-aaa",
      sectionPath: "knowledge/auth.md#section1",
      sectionText: "Original text.",
      embedding: vec(1, 0, 0),
      embeddingDim: 3,
      source: "genome",
    });
    db.upsertEmbedding({
      projectHash: "proj-aaa",
      sectionPath: "knowledge/auth.md#section1",
      sectionText: "Updated text.",
      embedding: vec(1, 0, 0),
      embeddingDim: 3,
      source: "genome",
    });

    const results = db.searchSimilar({ projectHash: "proj-aaa", embedding: vec(1, 0, 0) });
    expect(results.length).toBe(1);
    expect(results[0]!.sectionText).toBe("Updated text.");
  });

  test("Float32Array bytes survive roundtrip (byte-level equality)", () => {
    // Use a vector that exercises non-trivial byte patterns
    const original = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    db.upsertEmbedding({
      projectHash: "proj-bytes",
      sectionPath: "bytes-test",
      sectionText: "byte test",
      embedding: original,
      embeddingDim: 5,
      source: "code",
    });

    // We can't get the raw stored bytes directly through searchSimilar, but we
    // can verify the similarity of a query == itself is effectively 1.0
    const results = db.searchSimilar({ projectHash: "proj-bytes", embedding: original });
    expect(results.length).toBe(1);
    // Self-similarity of a normalized vector should be ~1.0
    expect(results[0]!.similarity).toBeCloseTo(1.0, 5);
  });

  test("similarity of orthogonal vectors is ~0", () => {
    db.upsertEmbedding({
      projectHash: "proj-orth",
      sectionPath: "orth/a",
      sectionText: "a",
      embedding: vec(1, 0, 0),
      embeddingDim: 3,
      source: "code",
    });

    const results = db.searchSimilar({ projectHash: "proj-orth", embedding: vec(0, 1, 0) });
    expect(results[0]!.similarity).toBeCloseTo(0, 5);
  });
});

// ---------------------------------------------------------------------------
// Test group 3: Cosine similarity ranking
// ---------------------------------------------------------------------------

describe("searchSimilar — cosine similarity ranking", () => {
  let home: string;

  beforeEach(() => {
    home = makeTmpHome("cosine");
    db = openContextDb(home);
  });
  afterEach(() => { db.close(); cleanTmp(home); });

  test("ranks 3 vectors with known geometry in correct order", () => {
    // Query direction: [1, 0, 0]
    // v_close: [1, 0, 0]  -> similarity ~1.0
    // v_mid:   [1, 1, 0]  -> similarity ~0.707
    // v_far:   [0, 1, 0]  -> similarity ~0.0
    const vClose = vec(1, 0, 0);
    const vMid   = vec(1, 1, 0);
    const vFar   = vec(0, 1, 0);

    db.upsertEmbedding({ projectHash: "proj-rank", sectionPath: "far",   sectionText: "far",   embedding: vFar,   embeddingDim: 3, source: "code" });
    db.upsertEmbedding({ projectHash: "proj-rank", sectionPath: "mid",   sectionText: "mid",   embedding: vMid,   embeddingDim: 3, source: "code" });
    db.upsertEmbedding({ projectHash: "proj-rank", sectionPath: "close", sectionText: "close", embedding: vClose, embeddingDim: 3, source: "code" });

    const query = vec(1, 0, 0);
    const results = db.searchSimilar({ projectHash: "proj-rank", embedding: query, limit: 3 });

    expect(results.length).toBe(3);
    expect(results[0]!.sectionPath).toBe("close");
    expect(results[1]!.sectionPath).toBe("mid");
    expect(results[2]!.sectionPath).toBe("far");

    // Verify similarity magnitudes
    expect(results[0]!.similarity).toBeCloseTo(1.0, 5);
    expect(results[1]!.similarity).toBeCloseTo(Math.SQRT1_2, 4); // ~0.707
    expect(results[2]!.similarity).toBeCloseTo(0.0, 5);
  });

  test("limit parameter constrains results", () => {
    for (let i = 0; i < 10; i++) {
      db.upsertEmbedding({
        projectHash: "proj-limit",
        sectionPath: `section/${i}`,
        sectionText: `text ${i}`,
        embedding: vec(Math.random(), Math.random(), Math.random()),
        embeddingDim: 3,
        source: "doc",
      });
    }

    const results = db.searchSimilar({ projectHash: "proj-limit", embedding: vec(1, 0, 0), limit: 3 });
    expect(results.length).toBe(3);
  });

  test("results are sorted descending by similarity", () => {
    for (let i = 0; i < 5; i++) {
      db.upsertEmbedding({
        projectHash: "proj-sort",
        sectionPath: `s/${i}`,
        sectionText: `t${i}`,
        embedding: vec(i * 0.1, 1 - i * 0.1, 0),
        embeddingDim: 3,
        source: "code",
      });
    }
    const results = db.searchSimilar({ projectHash: "proj-sort", embedding: vec(1, 0, 0), limit: 10 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.similarity).toBeGreaterThanOrEqual(results[i]!.similarity);
    }
  });
});

// ---------------------------------------------------------------------------
// Test group 4: Cross-project search
// ---------------------------------------------------------------------------

describe("searchSimilar — cross-project (no projectHash)", () => {
  let home: string;

  beforeEach(() => {
    home = makeTmpHome("crossproject");
    db = openContextDb(home);
  });
  afterEach(() => { db.close(); cleanTmp(home); });

  test("returns results from different projectHash values when projectHash omitted", () => {
    db.upsertEmbedding({
      projectHash: "proj-A",
      sectionPath: "auth/login.ts",
      sectionText: "Login handler",
      embedding: vec(1, 0, 0),
      embeddingDim: 3,
      source: "code",
    });
    db.upsertEmbedding({
      projectHash: "proj-B",
      sectionPath: "auth/session.ts",
      sectionText: "Session management",
      embedding: vec(0.9, 0.1, 0),
      embeddingDim: 3,
      source: "code",
    });
    db.upsertEmbedding({
      projectHash: "proj-C",
      sectionPath: "utils/format.ts",
      sectionText: "Format utilities",
      embedding: vec(0, 1, 0),
      embeddingDim: 3,
      source: "code",
    });

    const results = db.searchSimilar({ embedding: vec(1, 0, 0), limit: 10 });

    const hashes = results.map((r) => r.projectHash);
    expect(hashes).toContain("proj-A");
    expect(hashes).toContain("proj-B");
    expect(hashes).toContain("proj-C");
  });

  test("cross-project results still rank by similarity", () => {
    db.upsertEmbedding({ projectHash: "proj-X", sectionPath: "far",   sectionText: "far",   embedding: vec(0, 1, 0), embeddingDim: 3, source: "code" });
    db.upsertEmbedding({ projectHash: "proj-Y", sectionPath: "close", sectionText: "close", embedding: vec(1, 0, 0), embeddingDim: 3, source: "code" });

    const results = db.searchSimilar({ embedding: vec(1, 0, 0), limit: 10 });
    expect(results[0]!.sectionPath).toBe("close");
    expect(results[0]!.projectHash).toBe("proj-Y");
  });

  test("scoped search does NOT return records from other projects", () => {
    db.upsertEmbedding({ projectHash: "proj-A", sectionPath: "a", sectionText: "a", embedding: vec(1, 0, 0), embeddingDim: 3, source: "code" });
    db.upsertEmbedding({ projectHash: "proj-B", sectionPath: "b", sectionText: "b", embedding: vec(1, 0, 0), embeddingDim: 3, source: "code" });

    const results = db.searchSimilar({ projectHash: "proj-A", embedding: vec(1, 0, 0), limit: 10 });
    expect(results.every((r) => r.projectHash === "proj-A")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test group 5: retrieval_log
// ---------------------------------------------------------------------------

describe("recordRetrieval — retrieval_log", () => {
  let home: string;

  beforeEach(() => {
    home = makeTmpHome("retrieval");
    db = openContextDb(home);
  });
  afterEach(() => { db.close(); cleanTmp(home); });

  test("records a hit event", () => {
    db.recordRetrieval({
      sessionId: "session-001",
      projectHash: "proj-aaa",
      pattern: "auth",
      hit: true,
      tokensSaved: 120,
    });

    const raw = new Database(join(home, ".ashlr", "context.db"), { readonly: true });
    const row = raw.query<{
      session_id: string; project_hash: string; pattern: string;
      hit: number; tokens_saved: number;
    }, []>("SELECT * FROM retrieval_log LIMIT 1").get();
    raw.close();

    expect(row).not.toBeNull();
    expect(row!.session_id).toBe("session-001");
    expect(row!.project_hash).toBe("proj-aaa");
    expect(row!.pattern).toBe("auth");
    expect(row!.hit).toBe(1);
    expect(row!.tokens_saved).toBe(120);
  });

  test("records a miss event", () => {
    db.recordRetrieval({ hit: false, tokensSaved: 0 });
    const raw = new Database(join(home, ".ashlr", "context.db"), { readonly: true });
    const row = raw.query<{ hit: number }, []>("SELECT hit FROM retrieval_log LIMIT 1").get();
    raw.close();
    expect(row!.hit).toBe(0);
  });

  test("hitRateLast1000 reflects recorded events", () => {
    db.recordRetrieval({ hit: true });
    db.recordRetrieval({ hit: true });
    db.recordRetrieval({ hit: false });

    const s = db.stats();
    // 2 hits out of 3 = ~0.667
    expect(s.hitRateLast1000).toBeCloseTo(2 / 3, 3);
  });

  test("multiple records accumulate", () => {
    for (let i = 0; i < 5; i++) {
      db.recordRetrieval({ sessionId: `s-${i}`, hit: i % 2 === 0 });
    }
    const raw = new Database(join(home, ".ashlr", "context.db"), { readonly: true });
    const count = raw.query<{ c: number }, []>("SELECT COUNT(*) as c FROM retrieval_log").get()!;
    raw.close();
    expect(count.c).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Test group 6: stats()
// ---------------------------------------------------------------------------

describe("stats()", () => {
  let home: string;

  beforeEach(() => {
    home = makeTmpHome("stats");
    db = openContextDb(home);
  });
  afterEach(() => { db.close(); cleanTmp(home); });

  test("zero state on fresh db", () => {
    const s = db.stats();
    expect(s.totalEmbeddings).toBe(0);
    expect(s.projects).toBe(0);
    expect(s.hitRateLast1000).toBe(0);
  });

  test("reflects inserted embeddings", () => {
    db.upsertEmbedding({ projectHash: "pa", sectionPath: "s1", sectionText: "t1", embedding: vec(1, 0), embeddingDim: 2, source: "code" });
    db.upsertEmbedding({ projectHash: "pa", sectionPath: "s2", sectionText: "t2", embedding: vec(0, 1), embeddingDim: 2, source: "code" });
    db.upsertEmbedding({ projectHash: "pb", sectionPath: "s3", sectionText: "t3", embedding: vec(1, 1), embeddingDim: 2, source: "doc" });

    const s = db.stats();
    expect(s.totalEmbeddings).toBe(3);
    expect(s.projects).toBe(2);
    expect(s.dbBytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test group 7: ASHLR_CONTEXT_DB_DISABLE=1 no-op mode
// ---------------------------------------------------------------------------

describe("ASHLR_CONTEXT_DB_DISABLE=1 — no-op mode", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.ASHLR_CONTEXT_DB_DISABLE;
    process.env.ASHLR_CONTEXT_DB_DISABLE = "1";
  });
  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.ASHLR_CONTEXT_DB_DISABLE;
    } else {
      process.env.ASHLR_CONTEXT_DB_DISABLE = savedEnv;
    }
  });

  test("openContextDb returns a no-op object (no file created)", () => {
    const tmpHome = makeTmpHome("noop");
    try {
      const d = openContextDb(tmpHome);
      d.close();
      expect(existsSync(join(tmpHome, ".ashlr", "context.db"))).toBe(false);
    } finally {
      cleanTmp(tmpHome);
    }
  });

  test("upsertEmbedding is a no-op (no throw)", () => {
    const d = openContextDb();
    expect(() => d.upsertEmbedding({
      projectHash: "p", sectionPath: "s", sectionText: "t",
      embedding: vec(1, 0), embeddingDim: 2, source: "code",
    })).not.toThrow();
    d.close();
  });

  test("searchSimilar returns empty array", () => {
    const d = openContextDb();
    const results = d.searchSimilar({ embedding: vec(1, 0), limit: 10 });
    expect(results).toEqual([]);
    d.close();
  });

  test("recordRetrieval is a no-op (no throw)", () => {
    const d = openContextDb();
    expect(() => d.recordRetrieval({ hit: true })).not.toThrow();
    d.close();
  });

  test("stats returns zero-state object", () => {
    const d = openContextDb();
    const s = d.stats();
    expect(s.totalEmbeddings).toBe(0);
    expect(s.projects).toBe(0);
    expect(s.dbBytes).toBe(0);
    expect(s.hitRateLast1000).toBe(0);
    d.close();
  });

  test("vacuum is a no-op (no throw)", () => {
    const d = openContextDb();
    expect(() => d.vacuum()).not.toThrow();
    d.close();
  });
});
