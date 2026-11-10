/**
 * Unit tests for servers/_genome-cache.ts — LRU wrapper around retrieveSectionsV2.
 *
 * The cache module accepts an optional `retriever` parameter on retrieveCached,
 * so these tests inject a stub directly — no mock.module needed.  This keeps
 * @ashlr/core-efficiency's real exports intact in Bun's shared module cache,
 * preventing cross-file token-counting breakage in the full test suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { retrieveCached, _clearCache, _cacheSize } from "../servers/_genome-cache";

// ---------------------------------------------------------------------------
// Stub retriever — replaces retrieveSectionsV2 via DI, not mock.module
// ---------------------------------------------------------------------------

let retrieveCallCount = 0;
let retrieveResult: unknown[] = [{ id: "sec1", content: "hello" }];

async function stubRetriever(
  _root: string,
  _pattern: string,
  _limit: number,
): Promise<unknown[]> {
  retrieveCallCount++;
  return retrieveResult;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "genome-cache-"));
  retrieveCallCount = 0;
  retrieveResult = [{ id: "sec1", content: "hello" }];
  _clearCache();
});

afterEach(async () => {
  _clearCache();
  await rm(tmpHome, { recursive: true, force: true });
});

async function makeGenomeRoot(): Promise<string> {
  const root = join(tmpHome, "project");
  await mkdir(join(root, ".ashlrcode", "genome"), { recursive: true });
  await writeFile(join(root, ".ashlrcode", "genome", "manifest.json"), "{}");
  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("retrieveCached — cache miss", () => {
  test("returns and caches the retrieved sections on the first call", async () => {
    const root = await makeGenomeRoot();
    expect(_cacheSize()).toBe(0);

    const result = await retrieveCached(root, "foo", 4000, stubRetriever as any);

    expect(result as unknown).toEqual([{ id: "sec1", content: "hello" }]);
    expect(retrieveCallCount).toBe(1);
    expect(_cacheSize()).toBe(1);
  });
});

describe("retrieveCached — cache hit", () => {
  test("second call with same args hits cache, not retriever", async () => {
    const root = await makeGenomeRoot();
    await retrieveCached(root, "foo", 4000, stubRetriever as any);
    await retrieveCached(root, "foo", 4000, stubRetriever as any);
    expect(retrieveCallCount).toBe(1);
  });

  test("different patterns are cached independently", async () => {
    const root = await makeGenomeRoot();
    await retrieveCached(root, "alpha", 4000, stubRetriever as any);
    await retrieveCached(root, "beta", 4000, stubRetriever as any);
    await retrieveCached(root, "alpha", 4000, stubRetriever as any);
    await retrieveCached(root, "beta", 4000, stubRetriever as any);
    expect(retrieveCallCount).toBe(2);
    expect(_cacheSize()).toBe(2);
  });
});

describe("retrieveCached — manifest mtime invalidation", () => {
  test("bumped manifest mtime causes cache miss", async () => {
    const root = await makeGenomeRoot();
    await retrieveCached(root, "foo", 4000, stubRetriever as any);
    expect(retrieveCallCount).toBe(1);

    // Touch the manifest to bump mtime.
    await new Promise((r) => setTimeout(r, 10)); // ensure different mtime
    await writeFile(join(root, ".ashlrcode", "genome", "manifest.json"), "{}");

    await retrieveCached(root, "foo", 4000, stubRetriever as any);
    expect(retrieveCallCount).toBe(2);
  });
});

describe("retrieveCached — capacity eviction", () => {
  test("cache never grows beyond 64 entries", async () => {
    const root = await makeGenomeRoot();
    // Insert 70 unique patterns.
    for (let i = 0; i < 70; i++) {
      await retrieveCached(root, `pattern-${i}`, 4000, stubRetriever as any);
    }
    expect(_cacheSize()).toBeLessThanOrEqual(64);
  });
});

describe("retrieveCached — never throws", () => {
  test("does not throw when manifest path is missing", async () => {
    // genomeRoot with no manifest — manifestMtime returns 0, retriever still called.
    const root = join(tmpHome, "no-genome");
    await mkdir(root, { recursive: true });
    let threw = false;
    try {
      await retrieveCached(root, "anything", 4000, stubRetriever as any);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  test("returns empty array when retriever returns empty", async () => {
    retrieveResult = [];
    const root = await makeGenomeRoot();
    const result = await retrieveCached(root, "empty-pattern", 4000, stubRetriever as any);
    expect(result).toEqual([]);
  });
});
