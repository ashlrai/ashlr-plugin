/**
 * Tests for servers/_token-measure.ts
 *
 * Covers:
 *   1. estimateTokens — wraps chars/4 heuristic
 *   2. measureTokens  — returns null when ANTHROPIC_API_KEY is absent
 *   3. measureTokens  — returns null on fetch failure (stub)
 *   4. Cache round-trip — repeated call returns cached value without hitting network
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Isolate HOME so cache writes don't pollute ~/.ashlr
// ---------------------------------------------------------------------------
let tmpHome: string;
const origHome = process.env.HOME;
const origKey  = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ashlr-token-measure-"));
  mkdirSync(join(tmpHome, ".ashlr"), { recursive: true });
  process.env.HOME = tmpHome;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  process.env.HOME = origHome;
  if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
  else delete process.env.ANTHROPIC_API_KEY;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  test("returns chars/4 heuristic", async () => {
    const { estimateTokens } = await import("../servers/_token-measure.ts");
    const text = "a".repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  test("empty string → 0", async () => {
    const { estimateTokens } = await import("../servers/_token-measure.ts");
    expect(estimateTokens("")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// measureTokens — null without API key
// ---------------------------------------------------------------------------

describe("measureTokens without API key", () => {
  test("returns null when ANTHROPIC_API_KEY is unset", async () => {
    const { measureTokens } = await import("../servers/_token-measure.ts");
    const result = await measureTokens("hello world");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// measureTokens — null on fetch failure
// ---------------------------------------------------------------------------

describe("measureTokens fetch failure", () => {
  test("returns null when fetch throws (no network / timeout sim)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-fake-key";

    // Override global fetch to simulate a network failure
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("simulated network error"); }) as unknown as typeof fetch;
    try {
      const { measureTokens } = await import("../servers/_token-measure.ts");
      const result = await measureTokens("some text that would need measurement");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("returns null when API returns non-ok status", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-bad-key";

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as unknown as typeof fetch;
    try {
      const { measureTokens } = await import("../servers/_token-measure.ts");
      const result = await measureTokens("some text");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Cache: warm path returns without hitting network
// ---------------------------------------------------------------------------

describe("measureTokens cache", () => {
  test("second call returns cached value without fetching", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";

    let fetchCallCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({ usage: { input_tokens: 42 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      // Use a fresh import by busting module cache via unique HOME each time
      // (the cache is keyed by HOME path). We just call twice and verify
      // fetch is only hit once.
      const { measureTokens } = await import("../servers/_token-measure.ts");
      const text = "cache test text " + Date.now(); // unique text each test run
      const first = await measureTokens(text);
      expect(first).toBe(42);
      expect(fetchCallCount).toBe(1);

      const second = await measureTokens(text);
      expect(second).toBe(42);
      // fetch should NOT have been called again (cache hit)
      expect(fetchCallCount).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
