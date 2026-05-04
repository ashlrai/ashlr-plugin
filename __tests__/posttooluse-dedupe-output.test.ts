/**
 * Tests for hooks/posttooluse-dedupe-output.ts
 *
 * Covers:
 *   - Dedup fires when sha8 matches a prior turn for same tool class
 *   - Dedup does NOT fire when sha8 differs
 *   - Dedup does NOT fire for non-Read/Grep tools
 *   - Read↔ashlr__read treated as same class
 *   - Grep↔ashlr__grep treated as same class
 *   - Elision message format
 *   - ASHLR_SESSION_LOG=0 kill switch
 *   - bytesSaved accumulation via dedupStatsPath
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { decide, dedupStatsPath, type DecideOpts } from "../hooks/posttooluse-dedupe-output";
import { recordResult } from "../servers/_history-tracker";

let home: string;
const SESSION = "test-dedupe-session";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-dedupe-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.ASHLR_SESSION_LOG;
});

function opts(): DecideOpts {
  return { home, sessionId: SESSION };
}

function payload(toolName: string, content: string): Record<string, unknown> {
  return { tool_name: toolName, tool_result: content };
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe("kill switch", () => {
  test("ASHLR_SESSION_LOG=0 returns passThrough", () => {
    process.env.ASHLR_SESSION_LOG = "0";
    // Seed a prior result so a real duplicate exists.
    recordResult("Read", "same content", SESSION, home, Date.now() - 1000);
    const out = decide(payload("Read", "same content"), opts());
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool filtering
// ---------------------------------------------------------------------------

describe("tool filtering", () => {
  test("does not fire for Edit tool", () => {
    const out = decide({ tool_name: "Edit", tool_result: "anything" }, opts());
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("does not fire for Bash tool", () => {
    const out = decide({ tool_name: "Bash", tool_result: "hello" }, opts());
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("does not fire for Write tool", () => {
    const out = decide({ tool_name: "Write", tool_result: "data" }, opts());
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("does not fire for unknown tool", () => {
    const out = decide({ tool_name: "SomeNewTool", tool_result: "data" }, opts());
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No prior history → no dedup
// ---------------------------------------------------------------------------

describe("no prior history", () => {
  test("Read with empty history → no dedup", () => {
    const out = decide(payload("Read", "file content here"), opts());
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("Grep with empty history → no dedup", () => {
    const out = decide(payload("Grep", "match: foo bar"), opts());
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Duplicate detection — same content
// ---------------------------------------------------------------------------

describe("duplicate detection", () => {
  test("fires when Read repeats same content as prior Read turn", () => {
    const content = "const x = 1;\nconst y = 2;\n";
    // Seed turn 0 in history.
    recordResult("Read", content, SESSION, home, Date.now() - 5000);

    const out = decide(payload("Read", content), opts());
    expect(out.hookSpecificOutput.additionalContext).toBeDefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("[ashlr-dedupe]");
    expect(out.hookSpecificOutput.additionalContext).toContain("elided");
  });

  test("fires when ashlr__read repeats same content as prior Read (cross-variant)", () => {
    const content = "function foo() { return 42; }";
    recordResult("Read", content, SESSION, home, Date.now() - 3000);

    const out = decide(payload("mcp__plugin_ashlr_ashlr__ashlr__read", content), opts());
    expect(out.hookSpecificOutput.additionalContext).toBeDefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("[ashlr-dedupe]");
  });

  test("fires when Grep repeats same content as prior Grep turn", () => {
    const content = "src/foo.ts:42: match found\nsrc/bar.ts:7: another match\n";
    recordResult("Grep", content, SESSION, home, Date.now() - 2000);

    const out = decide(payload("Grep", content), opts());
    expect(out.hookSpecificOutput.additionalContext).toBeDefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("[ashlr-dedupe]");
  });

  test("fires when ashlr__grep repeats same content as prior Grep (cross-variant)", () => {
    const content = "pattern match line 1\npattern match line 2";
    recordResult("Grep", content, SESSION, home, Date.now() - 1000);

    const out = decide(payload("mcp__plugin_ashlr_ashlr__ashlr__grep", content), opts());
    expect(out.hookSpecificOutput.additionalContext).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// No dedup when sha differs
// ---------------------------------------------------------------------------

describe("no dedup when content differs", () => {
  test("different Read content → no dedup", () => {
    recordResult("Read", "content A", SESSION, home, Date.now() - 2000);

    const out = decide(payload("Read", "content B — different"), opts());
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("different Grep content → no dedup", () => {
    recordResult("Grep", "grep result set 1", SESSION, home, Date.now() - 2000);

    const out = decide(payload("Grep", "grep result set 2 — distinct"), opts());
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-class: Read history does NOT match Grep (different classes)
// ---------------------------------------------------------------------------

describe("cross-class no-match", () => {
  test("Read content does NOT dedupe against Grep history of same content", () => {
    const content = "same bytes in both tools";
    recordResult("Grep", content, SESSION, home, Date.now() - 1000);

    const out = decide(payload("Read", content), opts());
    // Read ≠ Grep class — should NOT dedupe.
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Elision message format
// ---------------------------------------------------------------------------

describe("elision message format", () => {
  test("contains turn number, sha8, and byte count", () => {
    const content = "export default function hello() { return 'world'; }";
    recordResult("Read", content, SESSION, home, Date.now() - 5000);

    const out = decide(payload("Read", content), opts());
    const msg = out.hookSpecificOutput.additionalContext ?? "";
    expect(msg).toContain("turn 0");
    expect(msg).toMatch(/sha8=[0-9a-f]{8}/);
    expect(msg).toMatch(/\d+B/);
  });
});

// ---------------------------------------------------------------------------
// bytesSaved accumulation
// ---------------------------------------------------------------------------

describe("bytesSaved accumulation", () => {
  test("dedupStatsPath returns path under ~/.ashlr/", () => {
    const p = dedupStatsPath(home);
    expect(p).toContain(".ashlr");
    expect(p).toContain("dedupe-stats.json");
  });

  test("bytesSaved increments after a dedupe", () => {
    const content = "a".repeat(500);
    recordResult("Read", content, SESSION, home, Date.now() - 3000);
    decide(payload("Read", content), opts());

    const { readFileSync } = require("fs") as typeof import("fs");
    const statsPath = dedupStatsPath(home);
    const stats = JSON.parse(readFileSync(statsPath, "utf-8")) as { bytesSaved: number; dedupeCount: number };
    expect(stats.bytesSaved).toBeGreaterThan(0);
    expect(stats.dedupeCount).toBe(1);
  });

  test("bytesSaved accumulates across multiple dedupes", () => {
    const contentA = "b".repeat(200);
    const contentB = "c".repeat(300);
    recordResult("Read", contentA, SESSION, home, Date.now() - 4000);
    recordResult("Grep", contentB, SESSION, home, Date.now() - 3000);

    decide(payload("Read", contentA), opts());
    decide(payload("Grep", contentB), opts());

    const { readFileSync } = require("fs") as typeof import("fs");
    const statsPath = dedupStatsPath(home);
    const stats = JSON.parse(readFileSync(statsPath, "utf-8")) as { bytesSaved: number; dedupeCount: number };
    expect(stats.dedupeCount).toBe(2);
    expect(stats.bytesSaved).toBeGreaterThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// Lookback window: only last 8 turns
// ---------------------------------------------------------------------------

describe("lookback window", () => {
  test("does not dedupe when prior match is older than 8 turns", () => {
    const content = "old content that should not match";
    // Seed as turn 0, then add 9 more different entries to push it out of window.
    recordResult("Read", content, SESSION, home, Date.now() - 10000);
    for (let i = 0; i < 9; i++) {
      recordResult("Read", `filler turn ${i}`, SESSION, home, Date.now() - (9 - i) * 100);
    }

    const out = decide(payload("Read", content), opts());
    // The old match is now > 8 turns ago in history — should not fire.
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("dedupes when prior match is within 8 turns", () => {
    const content = "recent content that should match";
    // Add 5 filler entries, then seed the match.
    for (let i = 0; i < 5; i++) {
      recordResult("Read", `filler ${i}`, SESSION, home, Date.now() - (10 - i) * 100);
    }
    recordResult("Read", content, SESSION, home, Date.now() - 100);

    const out = decide(payload("Read", content), opts());
    expect(out.hookSpecificOutput.additionalContext).toBeDefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("[ashlr-dedupe]");
  });
});
