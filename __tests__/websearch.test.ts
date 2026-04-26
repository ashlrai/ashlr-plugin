/**
 * Tests for ashlr__websearch — processWebSearchResults pipeline.
 *
 * No network calls are made. The native WebSearch subprocess is not invoked.
 * All tests exercise the pure post-processing pipeline (dedup, truncation,
 * summarize gate, recordSavingAccurate shape).
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock recordSavingAccurate before importing the server module.
// ---------------------------------------------------------------------------
import * as accounting from "../servers/_accounting";
import * as summarize from "../servers/_summarize";

let savingCalls: Array<{ rawBytes: number; compactBytes: number; toolName: string; cacheHit: boolean }> = [];

const recordSavingAccurateSpy = spyOn(accounting, "recordSavingAccurate").mockImplementation(async (opts) => {
  savingCalls.push(opts);
});

// Stub out summarizeIfLarge — we don't want real LLM calls in tests.
const summarizeSpy = spyOn(summarize, "summarizeIfLarge").mockImplementation(async (text, opts) => {
  return {
    text: `[mock summary of ${text.length} chars]`,
    summarized: true,
    wasCached: false,
    fellBack: false,
    outputBytes: 50,
  };
});

import { processWebSearchResults } from "../servers/websearch-server-handlers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeResult(
  domain: string,
  idx: number,
  score = 1.0,
  snippetLen = 100,
): { title: string; url: string; snippet: string; score: number } {
  return {
    title: `Result ${idx} from ${domain}`,
    url: `https://${domain}/page${idx}`,
    snippet: "x".repeat(snippetLen),
    score,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  savingCalls = [];
  summarizeSpy.mockClear();
  recordSavingAccurateSpy.mockClear();
});

describe("processWebSearchResults — basic call", () => {
  test("returns compact results with droppedCount=0 for small input", async () => {
    const raw = [makeResult("a.com", 1), makeResult("b.com", 2)];
    const out = await processWebSearchResults("test query", raw);
    expect(out.query).toBe("test query");
    expect(out.results).toHaveLength(2);
    expect(out.droppedCount).toBe(0);
  });

  test("respects maxResults cap", async () => {
    const raw = Array.from({ length: 10 }, (_, i) => makeResult(`site${i}.com`, i));
    const out = await processWebSearchResults("query", raw, { maxResults: 3 });
    expect(out.results).toHaveLength(3);
    expect(out.droppedCount).toBe(7);
  });

  test("recordSavingAccurate is called once per invocation", async () => {
    const raw = [makeResult("x.com", 1)];
    await processWebSearchResults("q", raw);
    expect(savingCalls).toHaveLength(1);
    expect(savingCalls[0]!.toolName).toBe("ashlr__websearch");
    expect(savingCalls[0]!.cacheHit).toBe(false);
    expect(savingCalls[0]!.rawBytes).toBeGreaterThan(0);
    expect(savingCalls[0]!.compactBytes).toBeGreaterThan(0);
  });
});

describe("processWebSearchResults — dedupe by domain", () => {
  test("keeps only one result per domain", async () => {
    const raw = [
      makeResult("example.com", 1, 0.9),
      makeResult("example.com", 2, 0.5), // duplicate domain, lower score
      makeResult("other.com", 3, 0.8),
    ];
    const out = await processWebSearchResults("q", raw, { maxResults: 10 });
    const domains = out.results.map((r) => new URL(r.url).hostname);
    expect(new Set(domains).size).toBe(domains.length); // all unique
    expect(out.results).toHaveLength(2);
    // example.com result should be the higher-scored one
    const exampleResult = out.results.find((r) => r.url.includes("example.com"));
    expect(exampleResult?.url).toContain("page1"); // idx=1 had score=0.9
  });

  test("higher-scored URL wins within a domain", async () => {
    const raw = [
      makeResult("clash.com", 1, 0.3),
      makeResult("clash.com", 2, 0.9), // higher score, should win
    ];
    const out = await processWebSearchResults("q", raw, { maxResults: 10 });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.url).toContain("page2");
  });

  test("droppedCount includes deduped entries", async () => {
    const raw = [
      makeResult("dup.com", 1, 1.0),
      makeResult("dup.com", 2, 0.5),
      makeResult("dup.com", 3, 0.1),
      makeResult("unique.com", 4, 0.8),
    ];
    const out = await processWebSearchResults("q", raw, { maxResults: 10 });
    // 3 dup.com → 1 kept, 2 dropped; 1 unique.com → 1 kept
    expect(out.droppedCount).toBe(2);
  });
});

describe("processWebSearchResults — snippet truncation", () => {
  test("snippets over 500 chars are truncated", async () => {
    const raw = [makeResult("a.com", 1, 1.0, 800)];
    const out = await processWebSearchResults("q", raw, { maxResults: 5, summarize: false });
    expect(out.results[0]!.snippet.length).toBeLessThanOrEqual(502); // +1 for ellipsis char
  });

  test("short snippets are not truncated", async () => {
    const raw = [makeResult("b.com", 1, 1.0, 50)];
    const out = await processWebSearchResults("q", raw, { maxResults: 5, summarize: false });
    expect(out.results[0]!.snippet).toBe("x".repeat(50));
  });
});

describe("processWebSearchResults — summarize gate", () => {
  test("summarize is NOT called when result count <= 3", async () => {
    summarizeSpy.mockClear();
    const raw = [makeResult("a.com", 1), makeResult("b.com", 2), makeResult("c.com", 3)];
    const out = await processWebSearchResults("q", raw, { maxResults: 5, summarize: true });
    expect(summarizeSpy).not.toHaveBeenCalled();
    expect(out.summary).toBeUndefined();
  });

  test("summarize IS called when result count > 3 and summarize=true", async () => {
    summarizeSpy.mockClear();
    const raw = Array.from({ length: 5 }, (_, i) => makeResult(`site${i}.com`, i + 1));
    const out = await processWebSearchResults("q", raw, { maxResults: 5, summarize: true });
    expect(summarizeSpy).toHaveBeenCalled();
    expect(out.summary).toBeDefined();
  });

  test("summarize is NOT called when summarize=false", async () => {
    summarizeSpy.mockClear();
    const raw = Array.from({ length: 5 }, (_, i) => makeResult(`s${i}.com`, i + 1));
    const out = await processWebSearchResults("q", raw, { maxResults: 5, summarize: false });
    expect(summarizeSpy).not.toHaveBeenCalled();
    expect(out.summary).toBeUndefined();
  });
});

describe("processWebSearchResults — recordSaving shape", () => {
  test("rawBytes > compactBytes for a large result set (compression happened)", async () => {
    // Many results with long snippets → dedup + truncation should reduce bytes.
    const raw = Array.from({ length: 8 }, (_, i) => makeResult(`s${i}.com`, i + 1, 1.0, 600));
    const out = await processWebSearchResults("q", raw, { maxResults: 4, summarize: false });
    expect(savingCalls[0]!.rawBytes).toBeGreaterThan(0);
    expect(savingCalls[0]!.compactBytes).toBeGreaterThan(0);
    // compactBytes should be less than rawBytes since we dropped half the results + truncated snippets.
    expect(savingCalls[0]!.rawBytes).toBeGreaterThan(savingCalls[0]!.compactBytes);
  });
});
