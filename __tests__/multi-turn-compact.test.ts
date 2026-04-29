/**
 * Tests for the /ashlr-compact slash command surface.
 *
 * Because /ashlr-compact is a markdown prompt (not executable code), these
 * tests validate the underlying data utilities it depends on:
 *   - staleByteTotal computes the correct savings estimate
 *   - annotateHistory produces the correct per-tool breakdown
 *   - The 5-turn threshold correctly separates fresh from stale
 *
 * Integration note: the actual slash command reads last-project.json for
 * sessionId and then reads the history JSONL. This test validates the
 * data layer that command relies on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  annotateHistory,
  historyPath,
  readHistory,
  recordResult,
  staleByteTotal,
  STALE_TURN_THRESHOLD,
  STALE_BYTES_NUDGE_THRESHOLD,
  historyDir,
} from "../servers/_history-tracker";

let home: string;
const SESSION = "compact-test-session";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-compact-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Savings estimate accuracy
// ---------------------------------------------------------------------------

describe("savings estimate", () => {
  test("empty session → 0 stale bytes", () => {
    const { staleBytes, staleResults } = staleByteTotal(SESSION, home);
    expect(staleBytes).toBe(0);
    expect(staleResults).toBe(0);
  });

  test("all-fresh session → 0 stale", () => {
    // 4 results — max turnDelta = 3 (below threshold of 5)
    const content = "a".repeat(500);
    for (let i = 0; i < 4; i++) {
      recordResult("Read", content, SESSION, home, 1000 + i);
    }
    const { staleBytes, staleResults } = staleByteTotal(SESSION, home);
    expect(staleBytes).toBe(0);
    expect(staleResults).toBe(0);
  });

  test("stale results are counted correctly at threshold boundary", () => {
    // 6 results → entry at turn 0 has delta=5 (exactly at threshold), entry at turn 1 has delta=4
    const content = "b".repeat(200);
    for (let i = 0; i < 6; i++) {
      recordResult("Read", content, SESSION, home, 1000 + i);
    }
    const { staleBytes, staleResults, sessionTurnCount } = staleByteTotal(SESSION, home);
    expect(sessionTurnCount).toBe(6);
    // Entry at turn 0: currentTurn=6, delta=6 → stale
    // Entry at turn 1: delta=5 → stale (at threshold)
    // Entry at turn 2: delta=4 → fresh
    expect(staleResults).toBe(2);
    expect(staleBytes).toBe(2 * Buffer.byteLength(content, "utf-8"));
  });

  test("savings estimate scales with result size", () => {
    const small = "x".repeat(100);
    const large = "y".repeat(10_000);
    // 5 small (turns 0-4) then 5 large (turns 5-9). currentTurn=10.
    // delta for small: 10,9,8,7,6 → all >= 5 → stale (5 results)
    // delta for large: 5,4,3,2,1 → turn 5 (delta=5) is stale, turns 6-9 fresh
    for (let i = 0; i < 5; i++) {
      recordResult("Read", small, SESSION, home, 1000 + i);
    }
    for (let i = 0; i < 5; i++) {
      recordResult("Grep", large, SESSION, home, 2000 + i);
    }
    const { staleBytes, staleResults } = staleByteTotal(SESSION, home);
    // 5 small + 1 large = 6 stale results
    expect(staleResults).toBe(6);
    const expectedBytes =
      5 * Buffer.byteLength(small, "utf-8") + Buffer.byteLength(large, "utf-8");
    expect(staleBytes).toBe(expectedBytes);
  });
});

// ---------------------------------------------------------------------------
// Per-tool breakdown (as /ashlr-compact would compute it)
// ---------------------------------------------------------------------------

describe("per-tool breakdown", () => {
  test("groups stale results by tool correctly", () => {
    // Add 5 Read results at turns 0-4, then 5 more to make first 5 stale
    const content = "z".repeat(300);
    for (let i = 0; i < 5; i++) {
      recordResult("Read", content, SESSION, home, 1000 + i);
    }
    for (let i = 0; i < 5; i++) {
      recordResult("Grep", "short", SESSION, home, 2000 + i);
    }
    // currentTurn=10; Read results (turns 0-4) all have delta ≥5 → stale
    // Grep results (turns 5-9) have delta 5,4,3,2,1 → 1 stale (turn 5, delta=5)
    const entries = readHistory(SESSION, home);
    const annotated = annotateHistory(entries, entries.length);
    const stale = annotated.filter((e) => e.isStale);

    const byTool: Record<string, { count: number; bytes: number }> = {};
    for (const e of stale) {
      byTool[e.tool] ??= { count: 0, bytes: 0 };
      byTool[e.tool]!.count++;
      byTool[e.tool]!.bytes += e.sizeBytes;
    }

    expect(byTool["Read"]?.count).toBe(5);
    expect(byTool["Grep"]?.count).toBe(1);
  });

  test("top entries sorted by sizeBytes descending", () => {
    // Produce entries with varying sizes
    const sizes = [100, 5000, 200, 3000, 150];
    for (let i = 0; i < sizes.length; i++) {
      recordResult("Read", "a".repeat(sizes[i]!), SESSION, home, 1000 + i);
    }
    // Add 5 more to push all previous to stale
    for (let i = 0; i < 5; i++) {
      recordResult("Read", "b", SESSION, home, 2000 + i);
    }
    const entries = readHistory(SESSION, home);
    const annotated = annotateHistory(entries, entries.length);
    const stale = annotated.filter((e) => e.isStale).sort((a, b) => b.sizeBytes - a.sizeBytes);

    expect(stale[0]!.sizeBytes).toBeGreaterThanOrEqual(stale[1]!.sizeBytes);
    expect(stale[0]!.sizeBytes).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Threshold constant is correct
// ---------------------------------------------------------------------------

describe("constants", () => {
  test("STALE_TURN_THRESHOLD is 5", () => {
    expect(STALE_TURN_THRESHOLD).toBe(5);
  });

  test("STALE_BYTES_NUDGE_THRESHOLD is 50KB", () => {
    expect(STALE_BYTES_NUDGE_THRESHOLD).toBe(50 * 1024);
  });
});

// ---------------------------------------------------------------------------
// History file can be read as JSONL (as /ashlr-compact does via Bash/Read)
// ---------------------------------------------------------------------------

describe("JSONL readability", () => {
  test("history file contains valid JSONL", () => {
    recordResult("Read", "file content here", SESSION, home, 1000);
    recordResult("Grep", "grep output here", SESSION, home, 2000);

    const { readFileSync } = require("fs") as typeof import("fs");
    const raw = readFileSync(historyPath(SESSION, home), "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("tool");
      expect(parsed).toHaveProperty("sizeBytes");
      expect(parsed).toHaveProperty("turn");
      expect(parsed).toHaveProperty("contentSha8");
    }
  });

  test("pre-written JSONL is correctly parsed by readHistory", () => {
    const dir = historyDir(home);
    mkdirSync(dir, { recursive: true });
    const entry = JSON.stringify({
      ts: 1000, tool: "Read", sizeBytes: 42, contentSha8: "abcd1234", turn: 0, sessionId: SESSION,
    });
    writeFileSync(historyPath(SESSION, home), entry + "\n", "utf-8");

    const entries = readHistory(SESSION, home);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sizeBytes).toBe(42);
  });

  test("malformed lines in JSONL are skipped gracefully", () => {
    const dir = historyDir(home);
    mkdirSync(dir, { recursive: true });
    const good = JSON.stringify({
      ts: 1000, tool: "Read", sizeBytes: 10, contentSha8: "00000000", turn: 0, sessionId: SESSION,
    });
    writeFileSync(
      historyPath(SESSION, home),
      good + "\n" + "NOT JSON\n" + good + "\n",
      "utf-8",
    );

    const entries = readHistory(SESSION, home);
    expect(entries).toHaveLength(2);
  });
});
