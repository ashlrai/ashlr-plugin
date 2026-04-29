/**
 * Tests for servers/_history-tracker.ts
 *
 * Covers:
 *   - recordResult / readHistory round-trip
 *   - sessionId scoping (different sessions → different files)
 *   - readCurrentTurn increments per entry
 *   - freshnessScore decay math
 *   - annotateHistory stale classification
 *   - staleByteTotal aggregation
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  annotateHistory,
  freshnessScore,
  FRESH_TURNS,
  historyPath,
  readCurrentTurn,
  readHistory,
  recordResult,
  sha8,
  STALE_BYTES_NUDGE_THRESHOLD,
  STALE_FRESHNESS,
  STALE_TURN_THRESHOLD,
  staleByteTotal,
  VERY_STALE_FRESHNESS,
} from "../servers/_history-tracker";

let home: string;
const SESSION_A = "test-session-aaa";
const SESSION_B = "test-session-bbb";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-history-tracker-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// sha8
// ---------------------------------------------------------------------------

describe("sha8", () => {
  test("returns 8-character hex string", () => {
    const h = sha8("hello world");
    expect(h).toHaveLength(8);
    expect(/^[0-9a-f]{8}$/.test(h)).toBe(true);
  });

  test("same input → same output", () => {
    expect(sha8("abc")).toBe(sha8("abc"));
  });

  test("different inputs → different outputs (probabilistic)", () => {
    expect(sha8("foo")).not.toBe(sha8("bar"));
  });

  test("empty string does not throw", () => {
    expect(() => sha8("")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// recordResult / readHistory round-trip
// ---------------------------------------------------------------------------

describe("recordResult + readHistory", () => {
  test("first record appears in history", () => {
    recordResult("Read", "content of file A", SESSION_A, home, 1000);
    const entries = readHistory(SESSION_A, home);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tool).toBe("Read");
    expect(entries[0]!.sizeBytes).toBeGreaterThan(0);
    expect(entries[0]!.turn).toBe(0);
    expect(entries[0]!.sessionId).toBe(SESSION_A);
  });

  test("second record has turn=1", () => {
    recordResult("Read", "file A", SESSION_A, home, 1000);
    recordResult("Grep", "grep results", SESSION_A, home, 2000);
    const entries = readHistory(SESSION_A, home);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.turn).toBe(1);
  });

  test("multiple records accumulate", () => {
    for (let i = 0; i < 5; i++) {
      recordResult("ashlr__read", `content ${i}`, SESSION_A, home, 1000 + i);
    }
    const entries = readHistory(SESSION_A, home);
    expect(entries).toHaveLength(5);
  });

  test("sessions are scoped independently", () => {
    recordResult("Read", "content A", SESSION_A, home, 1000);
    recordResult("Read", "content B", SESSION_B, home, 2000);

    const a = readHistory(SESSION_A, home);
    const b = readHistory(SESSION_B, home);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.sessionId).toBe(SESSION_A);
    expect(b[0]!.sessionId).toBe(SESSION_B);
  });

  test("readHistory returns [] when file missing", () => {
    const entries = readHistory("nonexistent-session", home);
    expect(entries).toEqual([]);
  });

  test("ASHLR_SESSION_LOG=0 disables writes", () => {
    const prev = process.env.ASHLR_SESSION_LOG;
    process.env.ASHLR_SESSION_LOG = "0";
    try {
      recordResult("Read", "content", SESSION_A, home, 1000);
      const entries = readHistory(SESSION_A, home);
      expect(entries).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.ASHLR_SESSION_LOG;
      else process.env.ASHLR_SESSION_LOG = prev;
    }
  });

  test("sizeBytes matches UTF-8 byte count", () => {
    const content = "hello";
    recordResult("Read", content, SESSION_A, home, 1000);
    const entries = readHistory(SESSION_A, home);
    expect(entries[0]!.sizeBytes).toBe(Buffer.byteLength(content, "utf-8"));
  });

  test("contentSha8 is consistent with sha8()", () => {
    const content = "test content for sha";
    recordResult("Read", content, SESSION_A, home, 1000);
    const entries = readHistory(SESSION_A, home);
    expect(entries[0]!.contentSha8).toBe(sha8(content));
  });
});

// ---------------------------------------------------------------------------
// readCurrentTurn
// ---------------------------------------------------------------------------

describe("readCurrentTurn", () => {
  test("returns 0 when no history exists", () => {
    expect(readCurrentTurn("no-session", home)).toBe(0);
  });

  test("increments with each recorded result", () => {
    expect(readCurrentTurn(SESSION_A, home)).toBe(0);
    recordResult("Read", "a", SESSION_A, home, 1000);
    expect(readCurrentTurn(SESSION_A, home)).toBe(1);
    recordResult("Grep", "b", SESSION_A, home, 2000);
    expect(readCurrentTurn(SESSION_A, home)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// freshnessScore
// ---------------------------------------------------------------------------

describe("freshnessScore", () => {
  test("turnDelta 0 is fresh (1.0)", () => {
    expect(freshnessScore(0)).toBe(1.0);
  });

  test("turnDelta FRESH_TURNS - 1 is still fresh", () => {
    expect(freshnessScore(FRESH_TURNS - 1)).toBe(1.0);
  });

  test("turnDelta FRESH_TURNS is stale", () => {
    expect(freshnessScore(FRESH_TURNS)).toBe(STALE_FRESHNESS);
  });

  test("turnDelta 14 is stale", () => {
    expect(freshnessScore(14)).toBe(STALE_FRESHNESS);
  });

  test("turnDelta 15 is very stale", () => {
    expect(freshnessScore(15)).toBe(VERY_STALE_FRESHNESS);
  });

  test("turnDelta 100 is very stale", () => {
    expect(freshnessScore(100)).toBe(VERY_STALE_FRESHNESS);
  });
});

// ---------------------------------------------------------------------------
// annotateHistory
// ---------------------------------------------------------------------------

describe("annotateHistory", () => {
  test("fresh entry has isStale=false", () => {
    const entries = [
      { ts: 1000, tool: "Read", sizeBytes: 100, contentSha8: "abc", turn: 18, sessionId: SESSION_A },
    ];
    const annotated = annotateHistory(entries, 20); // turnDelta = 2
    expect(annotated[0]!.isStale).toBe(false);
    expect(annotated[0]!.freshness).toBe(1.0);
    expect(annotated[0]!.turnDelta).toBe(2);
  });

  test("stale entry (turnDelta=5) has isStale=true", () => {
    const entries = [
      { ts: 1000, tool: "Read", sizeBytes: 200, contentSha8: "def", turn: 0, sessionId: SESSION_A },
    ];
    const annotated = annotateHistory(entries, STALE_TURN_THRESHOLD);
    expect(annotated[0]!.isStale).toBe(true);
    expect(annotated[0]!.freshness).toBe(STALE_FRESHNESS);
  });

  test("very stale entry (turnDelta=15) has freshness 0.2", () => {
    const entries = [
      { ts: 1000, tool: "Grep", sizeBytes: 500, contentSha8: "xyz", turn: 0, sessionId: SESSION_A },
    ];
    const annotated = annotateHistory(entries, 15);
    expect(annotated[0]!.freshness).toBe(VERY_STALE_FRESHNESS);
  });

  test("turnDelta cannot be negative", () => {
    // entry.turn > currentTurn (clock skew scenario)
    const entries = [
      { ts: 1000, tool: "Read", sizeBytes: 100, contentSha8: "abc", turn: 50, sessionId: SESSION_A },
    ];
    const annotated = annotateHistory(entries, 10);
    expect(annotated[0]!.turnDelta).toBe(0);
  });

  test("mixed entries classified correctly", () => {
    const currentTurn = 20;
    const entries = [
      { ts: 100, tool: "Read", sizeBytes: 100, contentSha8: "a", turn: 18, sessionId: SESSION_A }, // delta=2, fresh
      { ts: 200, tool: "Read", sizeBytes: 200, contentSha8: "b", turn: 10, sessionId: SESSION_A }, // delta=10, stale
      { ts: 300, tool: "Grep", sizeBytes: 300, contentSha8: "c", turn: 2,  sessionId: SESSION_A }, // delta=18, very stale
    ];
    const annotated = annotateHistory(entries, currentTurn);
    expect(annotated[0]!.isStale).toBe(false);
    expect(annotated[1]!.isStale).toBe(true);
    expect(annotated[1]!.freshness).toBe(STALE_FRESHNESS);
    expect(annotated[2]!.isStale).toBe(true);
    expect(annotated[2]!.freshness).toBe(VERY_STALE_FRESHNESS);
  });
});

// ---------------------------------------------------------------------------
// staleByteTotal
// ---------------------------------------------------------------------------

describe("staleByteTotal", () => {
  test("returns zeros when no history", () => {
    const result = staleByteTotal("no-session", home);
    expect(result.staleBytes).toBe(0);
    expect(result.staleResults).toBe(0);
    expect(result.sessionTurnCount).toBe(0);
  });

  test("fresh results contribute 0 stale bytes", () => {
    // Record 3 results at turn 0,1,2 — with currentTurn=3, all have delta<5
    for (let i = 0; i < 3; i++) {
      recordResult("Read", "content", SESSION_A, home, 1000 + i);
    }
    const result = staleByteTotal(SESSION_A, home);
    expect(result.staleBytes).toBe(0);
    expect(result.staleResults).toBe(0);
    expect(result.sessionTurnCount).toBe(3);
  });

  test("stale results contribute to stale bytes", () => {
    // Add 10 results so the first ones become stale (delta >= 5)
    const bigContent = "x".repeat(1000); // 1000 bytes each
    for (let i = 0; i < 10; i++) {
      recordResult("Read", bigContent, SESSION_A, home, 1000 + i);
    }
    // currentTurn=10; entries at turn 0..4 have delta=10..5, all stale
    const result = staleByteTotal(SESSION_A, home);
    expect(result.staleBytes).toBeGreaterThan(0);
    expect(result.staleResults).toBeGreaterThanOrEqual(5);
    expect(result.sessionTurnCount).toBe(10);
  });

  test("STALE_BYTES_NUDGE_THRESHOLD constant is 50KB", () => {
    expect(STALE_BYTES_NUDGE_THRESHOLD).toBe(50 * 1024);
  });
});
