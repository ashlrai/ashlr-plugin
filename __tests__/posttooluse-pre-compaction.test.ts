/**
 * Tests for 2B — pre-compaction nudge added to posttooluse-stale-result.ts
 *
 * Covers:
 *   - Nudge fires once when cumulative bytes > 260KB (65K tokens × 4 bytes)
 *   - Second invocation in same session does NOT re-fire
 *   - Nudge does NOT fire when bytes < 260KB
 *   - Nudge message contains percentage and /ashlr-compact hint
 *   - ASHLR_SESSION_LOG=0 suppresses everything
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { decide, type ProcessOpts } from "../hooks/posttooluse-stale-result";
import { historyPath, historyDir, type HistoryEntry } from "../servers/_history-tracker";

let home: string;
const SESSION = "test-precompact-session";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-precompact-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.ASHLR_SESSION_LOG;
});

function opts(overrides: Partial<ProcessOpts> = {}): ProcessOpts {
  return { home, sessionId: SESSION, now: Date.now(), ...overrides };
}

/**
 * Seed the session JSONL with entries totalling `totalBytes`.
 * We write one entry with the full byte count so the logic sees it immediately.
 */
function seedHistory(totalBytes: number): void {
  const dir = historyDir(home);
  mkdirSync(dir, { recursive: true });
  const p = historyPath(SESSION, home);
  // Each entry: fill sizeBytes so cumulative sum hits the threshold.
  const entry: HistoryEntry = {
    ts: Date.now() - 10000,
    tool: "Read",
    sizeBytes: totalBytes,
    contentSha8: "aabbccdd",
    turn: 0,
    sessionId: SESSION,
  };
  writeFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
}

function payloadFor(tool: string = "Read"): Record<string, unknown> {
  return { tool_name: tool, tool_result: "x" };
}

// ---------------------------------------------------------------------------
// Does not fire when bytes are low
// ---------------------------------------------------------------------------

describe("below threshold", () => {
  test("no nudge when cumulative bytes < 260KB", () => {
    seedHistory(10 * 1024); // 10 KB → ~2500 tokens
    const out = decide(payloadFor(), opts());
    // Should not contain the pre-compaction message.
    expect(out.hookSpecificOutput.additionalContext ?? "").not.toContain("auto-compact");
  });

  test("no nudge at exactly 260KB - 1 byte", () => {
    seedHistory(65_000 * 4 - 1);
    const out = decide(payloadFor(), opts());
    expect(out.hookSpecificOutput.additionalContext ?? "").not.toContain("auto-compact");
  });
});

// ---------------------------------------------------------------------------
// Fires once above threshold
// ---------------------------------------------------------------------------

describe("above threshold", () => {
  test("nudge fires when cumulative bytes > 260KB", () => {
    seedHistory(70_000 * 4); // 70K tokens worth
    const out = decide(payloadFor(), opts());
    const msg = out.hookSpecificOutput.additionalContext ?? "";
    expect(msg).toContain("auto-compact");
    expect(msg).toContain("/ashlr-compact");
  });

  test("nudge message contains a percentage", () => {
    seedHistory(70_000 * 4);
    const out = decide(payloadFor(), opts());
    const msg = out.hookSpecificOutput.additionalContext ?? "";
    // Should contain something like "87%" or "87%"
    expect(msg).toMatch(/\d+%/);
  });

  test("nudge message mentions 80K ceiling", () => {
    seedHistory(68_000 * 4);
    const out = decide(payloadFor(), opts());
    const msg = out.hookSpecificOutput.additionalContext ?? "";
    expect(msg).toContain("80K");
  });
});

// ---------------------------------------------------------------------------
// Once-per-session: second call does NOT re-fire
// ---------------------------------------------------------------------------

describe("once-per-session", () => {
  test("second call in same session does not re-fire pre-compaction nudge", () => {
    seedHistory(70_000 * 4);

    const first = decide(payloadFor(), opts());
    expect(first.hookSpecificOutput.additionalContext ?? "").toContain("auto-compact");

    // Second call with same session — flag file should exist.
    const second = decide(payloadFor(), opts());
    expect(second.hookSpecificOutput.additionalContext ?? "").not.toContain("auto-compact");
  });

  test("different session fires independently", () => {
    seedHistory(70_000 * 4);

    // Fire for session A.
    decide(payloadFor(), { home, sessionId: "session-A", now: Date.now() });

    // New session B with same history should still fire.
    const sessionBHistory = historyPath("session-B", home);
    const entry: HistoryEntry = {
      ts: Date.now() - 1000,
      tool: "Read",
      sizeBytes: 70_000 * 4,
      contentSha8: "deadbeef",
      turn: 0,
      sessionId: "session-B",
    };
    writeFileSync(sessionBHistory, JSON.stringify(entry) + "\n", "utf-8");

    const out = decide(payloadFor(), { home, sessionId: "session-B", now: Date.now() });
    expect(out.hookSpecificOutput.additionalContext ?? "").toContain("auto-compact");
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe("kill switch", () => {
  test("ASHLR_SESSION_LOG=0 suppresses pre-compaction nudge", () => {
    process.env.ASHLR_SESSION_LOG = "0";
    seedHistory(70_000 * 4);
    const out = decide(payloadFor(), opts());
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool filtering: only fires for tracked tools
// ---------------------------------------------------------------------------

describe("tool filtering", () => {
  test("pre-compaction check does not run for Edit tool", () => {
    seedHistory(70_000 * 4);
    const out = decide({ tool_name: "Edit", tool_result: "x" }, opts());
    // Edit is not a tracked tool → passThrough immediately.
    expect(out.hookSpecificOutput.additionalContext ?? "").not.toContain("auto-compact");
  });
});
