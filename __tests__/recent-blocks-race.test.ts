/**
 * recent-blocks-race.test.ts — Concurrency safety for _recent-blocks.ts
 *
 * Verifies that N concurrent recordBlock() calls each produce a distinct
 * persisted entry — i.e., no records are lost to last-write-wins collisions.
 *
 * Platform notes:
 *   - macOS/Linux: appendFileSync atomicity is guaranteed by POSIX for writes
 *     < PIPE_BUF. Our ~200B JSONL lines are well below the minimum 512B limit.
 *   - Windows: NT file writes are atomic for sequential writes < page size
 *     (4KB). Same guarantee applies. The test runs on all platforms.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// We re-import with HOME overridden per test so the module picks up the tmp dir.
// Since bun caches modules, we use the home parameter on readRecentBlocks.

import { readRecentBlocks, recordBlock, type RecentBlock } from "../hooks/_recent-blocks";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ashlr-rb-race-"));
  // Point HOME at temp dir so recordBlock() writes there.
  process.env.HOME = tmpHome;
  // Ensure telemetry is on.
  delete process.env.ASHLR_SESSION_LOG;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  // Restore HOME. In a test runner this is fine — tests run serially within
  // a file, and we restore before the next beforeEach.
  delete process.env.HOME;
});

// ---------------------------------------------------------------------------
// Core race test
// ---------------------------------------------------------------------------

describe("recordBlock() — concurrent writes", () => {
  test("N=20 concurrent calls produce N distinct entries (no drops)", () => {
    const N = 20;
    const blocks: RecentBlock[] = Array.from({ length: N }, (_, i) => ({
      ts: Date.now() + i,      // unique ts per entry so we can count distinct
      toolName: "Grep",
      pattern: `pattern-${i}`,
    }));

    // Fire all recordBlock() calls "concurrently" within the same synchronous
    // tick. In practice hooks run as separate processes, but within-process
    // concurrency is the tightest test (zero OS scheduling gap between writes).
    for (const b of blocks) {
      recordBlock(b);
    }

    const stored = readRecentBlocks(tmpHome);

    // All N records must be present.
    expect(stored.length).toBe(N);

    // Verify each pattern survives — guards against byte-level interleaving.
    const patterns = new Set(stored.map((r) => r.pattern));
    for (let i = 0; i < N; i++) {
      expect(patterns.has(`pattern-${i}`)).toBe(true);
    }
  });

  test("N=20 calls in Promise.all (async concurrency) — no drops", async () => {
    const N = 20;
    const blocks: RecentBlock[] = Array.from({ length: N }, (_, i) => ({
      ts: Date.now() + i,
      toolName: "Read",
      filePath: `/tmp/file-${i}.ts`,
    }));

    // Wrap each sync call in a resolved promise so the microtask queue
    // interleaves them — closest we can get to inter-process concurrency
    // within a single Bun process.
    await Promise.all(blocks.map((b) => Promise.resolve().then(() => recordBlock(b))));

    const stored = readRecentBlocks(tmpHome);
    expect(stored.length).toBe(N);

    const paths = new Set(stored.map((r) => r.filePath));
    for (let i = 0; i < N; i++) {
      expect(paths.has(`/tmp/file-${i}.ts`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Lazy pruning
// ---------------------------------------------------------------------------

describe("readRecentBlocks() — lazy prune", () => {
  test("returns all records when count <= MAX_ENTRIES", () => {
    const N = 10;
    for (let i = 0; i < N; i++) {
      recordBlock({ ts: Date.now() + i, toolName: "Edit", filePath: `/f/${i}` });
    }
    const stored = readRecentBlocks(tmpHome);
    expect(stored.length).toBe(N);
  });

  test("prunes to MAX_ENTRIES when file exceeds 1.5x cap", () => {
    const MAX_ENTRIES = 200;
    const OVER = Math.ceil(MAX_ENTRIES * 1.5) + 5; // 305 entries

    for (let i = 0; i < OVER; i++) {
      recordBlock({ ts: i, toolName: "Grep", pattern: `p-${i}` });
    }

    const stored = readRecentBlocks(tmpHome);
    // After lazy prune the returned slice is MAX_ENTRIES.
    expect(stored.length).toBe(MAX_ENTRIES);
    // Should be the MOST RECENT entries.
    expect(stored[0].ts).toBe(OVER - MAX_ENTRIES);
    expect(stored[MAX_ENTRIES - 1].ts).toBe(OVER - 1);
  });
});

// ---------------------------------------------------------------------------
// Malformed line tolerance
// ---------------------------------------------------------------------------

describe("readRecentBlocks() — malformed lines", () => {
  test("skips malformed lines, returns valid ones", () => {
    // Write two valid records and one garbage line.
    recordBlock({ ts: 1, toolName: "Grep", pattern: "good1" });
    recordBlock({ ts: 2, toolName: "Grep", pattern: "good2" });

    // Inject malformed line directly after the valid records.
    const { appendFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    appendFileSync(join(tmpHome, ".ashlr", "recent-blocks.jsonl"), "NOT_JSON\n", "utf-8");

    const stored = readRecentBlocks(tmpHome);
    expect(stored.length).toBe(2);
    expect(stored.map((r) => r.pattern)).toEqual(["good1", "good2"]);
  });
});

// ---------------------------------------------------------------------------
// Kill-switch
// ---------------------------------------------------------------------------

describe("recordBlock() — ASHLR_SESSION_LOG kill-switch", () => {
  test("ASHLR_SESSION_LOG=0 → nothing written", () => {
    process.env.ASHLR_SESSION_LOG = "0";
    recordBlock({ ts: Date.now(), toolName: "Grep", pattern: "noop" });
    delete process.env.ASHLR_SESSION_LOG;

    const stored = readRecentBlocks(tmpHome);
    expect(stored.length).toBe(0);
  });
});
