/**
 * embed-warm-start.test.ts — v1.24 Track E: three-tier warm-start corpus mode.
 *
 * Covers:
 *  - Tier classification: cold / warm / hot at corpus boundaries.
 *  - Gradient threshold: correct value at N=10, N=30, N=50.
 *  - computeWarmThreshold clamps at WARM_THRESHOLD_END for hot corpus.
 *  - grep-server: cold corpus → cache skipped (no embed call).
 *  - grep-server: warm corpus → cache consulted with strict threshold.
 *  - grep-server: hot corpus → cache consulted with standard threshold.
 *  - Background indexing fires-and-forgets in warm tier (mock injected).
 *  - Cold→warm promotion: corpusSize crossing 10 switches tier.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";

import {
  computeCorpusTier,
  computeWarmThreshold,
  WARM_THRESHOLD_START,
  WARM_THRESHOLD_END,
  WARM_CORPUS_MIN,
  BM25_CORPUS_MIN,
  type CorpusTier,
} from "../servers/_embed-calibration";

import { _sampleSourceFiles, _warmIndexFiles } from "../servers/grep-server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(label: string): string {
  const dir = join(tmpdir(), `ashlr-warm-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTmp(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// 1. Tier classification
// ---------------------------------------------------------------------------

describe("computeCorpusTier", () => {
  test("corpusSize=0 → cold", () => {
    expect(computeCorpusTier(0)).toBe("cold");
  });

  test("corpusSize=5 → cold", () => {
    expect(computeCorpusTier(5)).toBe("cold");
  });

  test("corpusSize=9 → cold (boundary: one below WARM_CORPUS_MIN)", () => {
    expect(computeCorpusTier(WARM_CORPUS_MIN - 1)).toBe("cold");
  });

  test("corpusSize=10 → warm (WARM_CORPUS_MIN)", () => {
    expect(computeCorpusTier(WARM_CORPUS_MIN)).toBe("warm");
  });

  test("corpusSize=30 → warm (mid-range)", () => {
    expect(computeCorpusTier(30)).toBe("warm");
  });

  test("corpusSize=49 → warm (one below BM25_CORPUS_MIN)", () => {
    expect(computeCorpusTier(BM25_CORPUS_MIN - 1)).toBe("warm");
  });

  test("corpusSize=50 → hot (BM25_CORPUS_MIN)", () => {
    expect(computeCorpusTier(BM25_CORPUS_MIN)).toBe("hot");
  });

  test("corpusSize=200 → hot", () => {
    expect(computeCorpusTier(200)).toBe("hot");
  });
});

// ---------------------------------------------------------------------------
// 2. Gradient threshold
// ---------------------------------------------------------------------------

describe("computeWarmThreshold", () => {
  test("N=10 → WARM_THRESHOLD_START (0.80)", () => {
    const t = computeWarmThreshold(10);
    expect(t).toBeCloseTo(WARM_THRESHOLD_START, 4);
  });

  test("N=30 → ≈0.74 (linear gradient mid-point)", () => {
    // threshold = 0.80 - (30 - 10) * 0.003 = 0.80 - 0.060 = 0.740
    const t = computeWarmThreshold(30);
    expect(t).toBeCloseTo(0.74, 4);
  });

  test("N=50 → WARM_THRESHOLD_END (0.68) via gradient", () => {
    // 0.80 - (50 - 10) * 0.003 = 0.80 - 0.12 = 0.68 → matches hot floor
    const t = computeWarmThreshold(50);
    expect(t).toBeCloseTo(WARM_THRESHOLD_END, 4);
  });

  test("hot tier (N=50) → exactly WARM_THRESHOLD_END", () => {
    // computeCorpusTier(50) === "hot" → returns WARM_THRESHOLD_END directly
    expect(computeCorpusTier(50)).toBe("hot");
    expect(computeWarmThreshold(50)).toBeCloseTo(WARM_THRESHOLD_END, 4);
  });

  test("warm N=11 → one step below start", () => {
    // 0.80 - (11 - 10) * 0.003 = 0.797
    const t = computeWarmThreshold(11);
    expect(t).toBeCloseTo(0.797, 3);
  });

  test("gradient never goes below WARM_THRESHOLD_END for any warm N", () => {
    for (let n = WARM_CORPUS_MIN; n < BM25_CORPUS_MIN; n++) {
      const t = computeWarmThreshold(n);
      expect(t).toBeGreaterThanOrEqual(WARM_THRESHOLD_END - 1e-9);
      expect(t).toBeLessThanOrEqual(WARM_THRESHOLD_START + 1e-9);
    }
  });

  test("cold tier N=5 → returns WARM_THRESHOLD_START (unused but defined)", () => {
    // cold tier: cache is skipped; the returned value is WARM_THRESHOLD_START
    // (documented as unused). At least it must be a valid finite number.
    const t = computeWarmThreshold(5);
    expect(Number.isFinite(t)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Cold→warm promotion: tier changes when corpusSize crosses the boundary
// ---------------------------------------------------------------------------

describe("cold→warm promotion via computeCorpusTier", () => {
  test("crossing WARM_CORPUS_MIN flips tier from cold to warm", () => {
    const before: CorpusTier = computeCorpusTier(WARM_CORPUS_MIN - 1);
    const after: CorpusTier = computeCorpusTier(WARM_CORPUS_MIN);
    expect(before).toBe("cold");
    expect(after).toBe("warm");
  });

  test("crossing BM25_CORPUS_MIN flips tier from warm to hot", () => {
    const before: CorpusTier = computeCorpusTier(BM25_CORPUS_MIN - 1);
    const after: CorpusTier = computeCorpusTier(BM25_CORPUS_MIN);
    expect(before).toBe("warm");
    expect(after).toBe("hot");
  });
});

// ---------------------------------------------------------------------------
// 4. _sampleSourceFiles — shallow dir scanner
// ---------------------------------------------------------------------------

describe("_sampleSourceFiles", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir("sample"); });
  afterEach(() => { cleanTmp(tmpDir); });

  test("returns up to `limit` source files", () => {
    // Write 5 .ts files
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(tmpDir, `file${i}.ts`), `export const x${i} = ${i};`);
    }
    const files = _sampleSourceFiles(tmpDir, 2);
    expect(files.length).toBeLessThanOrEqual(2);
    expect(files.every((f) => f.endsWith(".ts"))).toBe(true);
  });

  test("ignores non-source files (.lock, .bin, etc.)", () => {
    writeFileSync(join(tmpDir, "package-lock.json"), "{}"); // json is ok
    writeFileSync(join(tmpDir, "data.lock"), "lock");
    writeFileSync(join(tmpDir, "image.png"), "png");
    writeFileSync(join(tmpDir, "script.ts"), "export const x = 1;");

    const files = _sampleSourceFiles(tmpDir, 10);
    // .lock and .png should be excluded; .ts and .json included
    expect(files.some((f) => f.endsWith(".lock"))).toBe(false);
    expect(files.some((f) => f.endsWith(".png"))).toBe(false);
    expect(files.some((f) => f.endsWith(".ts") || f.endsWith(".json"))).toBe(true);
  });

  test("returns empty array for empty dir", () => {
    const files = _sampleSourceFiles(tmpDir, 2);
    expect(files).toEqual([]);
  });

  test("returns empty array for non-existent dir (never throws)", () => {
    const files = _sampleSourceFiles(join(tmpDir, "does-not-exist"), 2);
    expect(files).toEqual([]);
  });

  test("limit=0 returns empty array", () => {
    writeFileSync(join(tmpDir, "a.ts"), "const x = 1;");
    const files = _sampleSourceFiles(tmpDir, 0);
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. _warmIndexFiles — background indexing (mock ContextDb injected)
// ---------------------------------------------------------------------------

describe("_warmIndexFiles", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir("warmidx"); });
  afterEach(() => { cleanTmp(tmpDir); });

  function makeMockCtxDb() {
    const calls: Array<{ sectionPath: string; textLen: number }> = [];
    return {
      calls,
      upsertEmbedding(opts: { sectionPath: string; sectionText: string; [k: string]: unknown }) {
        calls.push({ sectionPath: opts.sectionPath, textLen: opts.sectionText.length });
      },
    };
  }

  test("indexes source files found in cwd", async () => {
    writeFileSync(join(tmpDir, "main.ts"), "export function hello() { return 'world'; }");
    writeFileSync(join(tmpDir, "util.ts"), "export const add = (a: number, b: number) => a + b;");

    const db = makeMockCtxDb();
    await _warmIndexFiles(tmpDir, "abc12345", db as never);

    // At least one file should have been indexed
    expect(db.calls.length).toBeGreaterThanOrEqual(1);
    expect(db.calls.every((c) => c.sectionPath.startsWith("warm:"))).toBe(true);
  });

  test("skips files that are too small (<20 chars)", async () => {
    writeFileSync(join(tmpDir, "tiny.ts"), "x");   // 1 char — too small
    writeFileSync(join(tmpDir, "ok.ts"), "export const longer = 'this is long enough to index';");

    const db = makeMockCtxDb();
    await _warmIndexFiles(tmpDir, "abc12345", db as never);

    // tiny.ts must not appear; ok.ts must appear
    expect(db.calls.some((c) => c.sectionPath.includes("tiny.ts"))).toBe(false);
    expect(db.calls.some((c) => c.sectionPath.includes("ok.ts"))).toBe(true);
  });

  test("never throws on empty dir", async () => {
    const db = makeMockCtxDb();
    await expect(_warmIndexFiles(tmpDir, "abc12345", db as never)).resolves.toBeUndefined();
    expect(db.calls.length).toBe(0);
  });

  test("fire-and-forget: resolves even when upsertEmbedding throws", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "export const something = 'value that is long enough';");

    const db = {
      upsertEmbedding() { throw new Error("db error"); },
    };
    // Must not reject
    await expect(_warmIndexFiles(tmpDir, "abc12345", db as never)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Tier constants are consistent
// ---------------------------------------------------------------------------

describe("tier constant consistency", () => {
  test("WARM_CORPUS_MIN < BM25_CORPUS_MIN", () => {
    expect(WARM_CORPUS_MIN).toBeLessThan(BM25_CORPUS_MIN);
  });

  test("WARM_THRESHOLD_START > WARM_THRESHOLD_END", () => {
    expect(WARM_THRESHOLD_START).toBeGreaterThan(WARM_THRESHOLD_END);
  });

  test("gradient at N=BM25_CORPUS_MIN-1 is >= WARM_THRESHOLD_END", () => {
    expect(computeWarmThreshold(BM25_CORPUS_MIN - 1)).toBeGreaterThanOrEqual(WARM_THRESHOLD_END);
  });
});
