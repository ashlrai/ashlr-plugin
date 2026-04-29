/**
 * Tests for the stale-detection adaptive nudge in posttooluse-stale-result.ts.
 *
 * Covers:
 *   - decide() passes through non-tracked tools
 *   - decide() records tracked tools in history
 *   - Nudge fires once when stale bytes exceed threshold
 *   - Nudge is throttled (fires only once per session)
 *   - Kill switch ASHLR_SESSION_LOG=0 disables everything
 *   - Nudge message contains KB estimate and /ashlr-compact hint
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { decide } from "../hooks/posttooluse-stale-result";
import { recordResult, STALE_BYTES_NUDGE_THRESHOLD } from "../servers/_history-tracker";

let home: string;
const SESSION = "nudge-stale-test-session";

// Build a large tool result payload to force stale byte accumulation
function bigPayload(tool: string, sizeBytes: number): Record<string, unknown> {
  return {
    tool_name: tool,
    tool_result: "x".repeat(sizeBytes),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-orient-nudge-stale-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pass-through for non-tracked tools
// ---------------------------------------------------------------------------

describe("non-tracked tools", () => {
  test("Edit passes through without recording", () => {
    const out = decide({ tool_name: "Edit" }, { home, sessionId: SESSION });
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("Write passes through", () => {
    const out = decide({ tool_name: "Write" }, { home, sessionId: SESSION });
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("missing tool_name passes through", () => {
    const out = decide({}, { home, sessionId: SESSION });
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("Bash passes through", () => {
    const out = decide({ tool_name: "Bash" }, { home, sessionId: SESSION });
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tracked tools — recording without nudge (below threshold)
// ---------------------------------------------------------------------------

describe("tracked tools below nudge threshold", () => {
  test("Read is recorded and returns pass-through when below threshold", () => {
    const out = decide(
      { tool_name: "Read", tool_result: "small result" },
      { home, sessionId: SESSION },
    );
    // Not enough stale bytes yet — no nudge
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  });

  test("Grep is tracked", () => {
    const out = decide(
      { tool_name: "Grep", tool_result: "some matches" },
      { home, sessionId: SESSION },
    );
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("ashlr__read is tracked", () => {
    const out = decide(
      { tool_name: "ashlr__read", tool_result: "file content" },
      { home, sessionId: SESSION },
    );
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("mcp__plugin_ashlr_ashlr__ashlr__grep is tracked", () => {
    const out = decide(
      {
        tool_name: "mcp__plugin_ashlr_ashlr__ashlr__grep",
        tool_result: "grep output",
      },
      { home, sessionId: SESSION },
    );
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adaptive nudge — fires at threshold
// ---------------------------------------------------------------------------

describe("adaptive nudge", () => {
  test("nudge fires when stale bytes exceed 50KB threshold", () => {
    // Pre-populate: add 10 entries in session to make first 5 stale,
    // with enough bytes to exceed the 50KB threshold
    const bigContent = "z".repeat(12_000); // 12KB each, 5 stale = 60KB

    // Record 10 results: first 5 will be stale (delta >= 5) when currentTurn=10
    for (let i = 0; i < 10; i++) {
      recordResult("Read", bigContent, SESSION, home, 1000 + i);
    }

    // Now call decide with a Read — staleByteTotal will be ~60KB > 50KB threshold
    const out = decide(
      { tool_name: "Read", tool_result: "new result" },
      { home, sessionId: SESSION },
    );

    expect(out.hookSpecificOutput.additionalContext).toBeDefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("ashlr");
    expect(out.hookSpecificOutput.additionalContext).toContain("/ashlr-compact");
    expect(out.hookSpecificOutput.additionalContext).toContain("KB");
  });

  test("nudge fires only once per session (throttled)", () => {
    const bigContent = "y".repeat(12_000);
    for (let i = 0; i < 10; i++) {
      recordResult("Read", bigContent, SESSION, home, 1000 + i);
    }

    // First call — should fire nudge
    const first = decide(
      { tool_name: "Read", tool_result: "new" },
      { home, sessionId: SESSION },
    );
    expect(first.hookSpecificOutput.additionalContext).toBeDefined();

    // Second call — same session, nudge already fired
    const second = decide(
      { tool_name: "Read", tool_result: "new2" },
      { home, sessionId: SESSION },
    );
    expect(second.hookSpecificOutput.additionalContext).toBeUndefined();

    // Third call — still throttled
    const third = decide(
      { tool_name: "Grep", tool_result: "new3" },
      { home, sessionId: SESSION },
    );
    expect(third.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("different sessions can each fire their own nudge", () => {
    const SESSION_2 = "nudge-session-two";
    const bigContent = "a".repeat(12_000);

    // Set up both sessions with stale bytes
    for (let i = 0; i < 10; i++) {
      recordResult("Read", bigContent, SESSION, home, 1000 + i);
      recordResult("Read", bigContent, SESSION_2, home, 2000 + i);
    }

    const out1 = decide(
      { tool_name: "Read", tool_result: "r1" },
      { home, sessionId: SESSION },
    );
    const out2 = decide(
      { tool_name: "Read", tool_result: "r2" },
      { home, sessionId: SESSION_2 },
    );

    // Both should fire (separate session state files)
    expect(out1.hookSpecificOutput.additionalContext).toBeDefined();
    expect(out2.hookSpecificOutput.additionalContext).toBeDefined();
  });

  test("nudge message contains stale KB count", () => {
    const bigContent = "m".repeat(12_000);
    for (let i = 0; i < 10; i++) {
      recordResult("Read", bigContent, SESSION, home, 1000 + i);
    }
    const out = decide(
      { tool_name: "Read", tool_result: "r" },
      { home, sessionId: SESSION },
    );
    const msg = out.hookSpecificOutput.additionalContext ?? "";
    // Should mention a KB value > 0
    expect(/\d+\s*KB/.test(msg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe("kill switch", () => {
  test("ASHLR_SESSION_LOG=0 returns pass-through", () => {
    const prev = process.env.ASHLR_SESSION_LOG;
    process.env.ASHLR_SESSION_LOG = "0";
    try {
      const bigContent = "k".repeat(12_000);
      for (let i = 0; i < 10; i++) {
        recordResult("Read", bigContent, SESSION, home, 1000 + i);
      }
      const out = decide(
        { tool_name: "Read", tool_result: "content" },
        { home, sessionId: SESSION },
      );
      expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ASHLR_SESSION_LOG;
      else process.env.ASHLR_SESSION_LOG = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Hook output shape
// ---------------------------------------------------------------------------

describe("hook output shape", () => {
  test("always returns hookEventName: PostToolUse", () => {
    const out = decide({ tool_name: "Read", tool_result: "x" }, { home, sessionId: SESSION });
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  });

  test("non-tracked tool returns correct shape", () => {
    const out = decide({ tool_name: "Edit" }, { home, sessionId: SESSION });
    expect(out).toMatchObject({
      hookSpecificOutput: { hookEventName: "PostToolUse" },
    });
  });
});
