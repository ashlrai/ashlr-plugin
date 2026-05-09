/**
 * Unit tests for hooks/sessionend-savings-nudge.ts
 *
 * Coverage:
 *   - nudge fires at $5 / $25 / $100 lifetime threshold
 *   - nudge dedupes (doesn't re-fire on next call)
 *   - nudge does NOT fire when savings = 0
 *   - session-time milestone (2h, 7h) fires once per session
 *   - session-time milestone dedupes within same session
 *   - checkAndFireNudge: missing stats → null
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildLifetimeThresholdNudge,
  buildSessionMilestoneNudge,
  checkAndFireNudge,
  computeNudge,
  readNudgeState,
  writeNudgeState,
  type NudgeState,
} from "../hooks/sessionend-savings-nudge";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-nudge-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeStats(
  lifetimeTokensSaved: number,
  sessionStartedAt: string = new Date().toISOString(),
  sessionTokensSaved = 1000,
): Promise<void> {
  const stats = {
    schemaVersion: 2,
    sessions: {
      "test-sid": {
        startedAt: sessionStartedAt,
        tokensSaved: sessionTokensSaved,
      },
    },
    lifetime: { tokensSaved: lifetimeTokensSaved, calls: 10, byTool: {}, byDay: {} },
  };
  await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(stats));
}

const emptyState: NudgeState = { last_session_nudge_ts: null, lifetime_nudge_ticks: [] };

// ---------------------------------------------------------------------------
// nudge text builders
// ---------------------------------------------------------------------------

describe("buildLifetimeThresholdNudge", () => {
  test("includes threshold and /ashlr-tier CTA", () => {
    const text = buildLifetimeThresholdNudge(5, 5.42);
    expect(text).toContain("$5.42");
    expect(text).toContain("/ashlr-tier");
  });

  test("rounds large amounts to integer", () => {
    const text = buildLifetimeThresholdNudge(100, 123.7);
    expect(text).toContain("$124");
  });
});

describe("buildSessionMilestoneNudge", () => {
  test("includes label and /ashlr-tier CTA", () => {
    const text = buildSessionMilestoneNudge("2h");
    expect(text).toContain("2h");
    expect(text).toContain("/ashlr-tier");
  });
});

// ---------------------------------------------------------------------------
// computeNudge — pure logic
// ---------------------------------------------------------------------------

describe("computeNudge — lifetime thresholds", () => {
  test("fires at $5 threshold when not previously ticked", () => {
    // costFor(tokens) at Haiku pricing — use enough tokens to exceed $5.
    // Haiku input ~$0.80/MTok. $5 = ~6.25M tokens. Use a large enough count.
    // We'll use a mock-friendly approach: pass tokens that map to ~$5.
    // costFor uses the actual pricing table — so we pass a token count that
    // yields ≥$5 using the real function.
    const { costFor } = require("../servers/_pricing");
    // Find how many tokens map to ≥$5 under default pricing.
    const tokens = Math.ceil((5 / costFor(1_000_000)) * 1_000_000);

    const result = computeNudge(tokens, 0, emptyState, "", Date.now());
    expect(result.kind).toBe("lifetime_threshold");
    expect(result.thresholdLabel).toBe("$5");
    expect(result.nudgeText).not.toBeNull();
    expect(result.nudgeText).toContain("/ashlr-tier");
  });

  test("does NOT fire when savings = 0", () => {
    const result = computeNudge(0, 0, emptyState, "", Date.now());
    expect(result.nudgeText).toBeNull();
    expect(result.kind).toBeNull();
  });

  test("does NOT re-fire $5 threshold if already ticked", () => {
    const { costFor } = require("../servers/_pricing");
    const tokens = Math.ceil((5 / costFor(1_000_000)) * 1_000_000);
    const state: NudgeState = { last_session_nudge_ts: null, lifetime_nudge_ticks: [5] };

    const result = computeNudge(tokens, 0, state, "", Date.now());
    // Should not fire $5 again; $25 and $100 not crossed yet.
    expect(result.nudgeText).toBeNull();
  });

  test("fires $25 when $5 already ticked and $25 crossed", () => {
    const { costFor } = require("../servers/_pricing");
    const tokens = Math.ceil((25 / costFor(1_000_000)) * 1_000_000);
    const state: NudgeState = { last_session_nudge_ts: null, lifetime_nudge_ticks: [5] };

    const result = computeNudge(tokens, 0, state, "", Date.now());
    expect(result.kind).toBe("lifetime_threshold");
    expect(result.thresholdLabel).toBe("$25");
  });

  test("fires $100 when $5 and $25 already ticked", () => {
    const { costFor } = require("../servers/_pricing");
    const tokens = Math.ceil((100 / costFor(1_000_000)) * 1_000_000);
    const state: NudgeState = { last_session_nudge_ts: null, lifetime_nudge_ticks: [5, 25] };

    const result = computeNudge(tokens, 0, state, "", Date.now());
    expect(result.kind).toBe("lifetime_threshold");
    expect(result.thresholdLabel).toBe("$100");
  });

  test("does NOT fire any threshold when all crossed", () => {
    const { costFor } = require("../servers/_pricing");
    const tokens = Math.ceil((100 / costFor(1_000_000)) * 1_000_000);
    const state: NudgeState = { last_session_nudge_ts: null, lifetime_nudge_ticks: [5, 25, 100] };

    const result = computeNudge(tokens, 0, state, "", Date.now());
    expect(result.nudgeText).toBeNull();
  });
});

describe("computeNudge — session milestones", () => {
  const sessionStart = "2026-05-08T10:00:00.000Z";
  // Small lifetime savings (below any $ threshold so lifetime nudges don't fire)
  const smallSavings = 100;

  test("fires 2h milestone when session > 2h and not yet nudged", () => {
    const durationMs = 2 * 60 * 60_000 + 1000; // 2h + 1s
    const result = computeNudge(smallSavings, durationMs, emptyState, sessionStart, Date.now());
    expect(result.kind).toBe("session_milestone");
    expect(result.thresholdLabel).toBe("2h");
  });

  test("fires 7h milestone over 2h when session > 7h", () => {
    const durationMs = 7 * 60 * 60_000 + 1000;
    const result = computeNudge(smallSavings, durationMs, emptyState, sessionStart, Date.now());
    expect(result.kind).toBe("session_milestone");
    expect(result.thresholdLabel).toBe("7h");
  });

  test("does NOT fire when session < 2h", () => {
    const durationMs = 60 * 60_000; // 1h
    const result = computeNudge(smallSavings, durationMs, emptyState, sessionStart, Date.now());
    expect(result.nudgeText).toBeNull();
  });

  test("does NOT fire session milestone if already nudged this session", () => {
    const durationMs = 3 * 60 * 60_000;
    const state: NudgeState = {
      last_session_nudge_ts: sessionStart,
      lifetime_nudge_ticks: [],
    };
    const result = computeNudge(smallSavings, durationMs, state, sessionStart, Date.now());
    expect(result.nudgeText).toBeNull();
  });

  test("fires again for new session (different sessionStart)", () => {
    const durationMs = 3 * 60 * 60_000;
    const state: NudgeState = {
      last_session_nudge_ts: "2026-05-07T10:00:00.000Z", // previous session
      lifetime_nudge_ticks: [],
    };
    const result = computeNudge(smallSavings, durationMs, state, sessionStart, Date.now());
    expect(result.kind).toBe("session_milestone");
  });
});

// ---------------------------------------------------------------------------
// IO round-trip
// ---------------------------------------------------------------------------

describe("readNudgeState / writeNudgeState", () => {
  test("missing file → returns default state", () => {
    const s = readNudgeState(home);
    expect(s.last_session_nudge_ts).toBeNull();
    expect(s.lifetime_nudge_ticks).toEqual([]);
  });

  test("round-trip write/read", () => {
    const state: NudgeState = {
      last_session_nudge_ts: "2026-05-08T10:00:00.000Z",
      lifetime_nudge_ticks: [5, 25],
    };
    writeNudgeState(state, home);
    const back = readNudgeState(home);
    expect(back.last_session_nudge_ts).toBe("2026-05-08T10:00:00.000Z");
    expect(back.lifetime_nudge_ticks).toEqual([5, 25]);
  });
});

// ---------------------------------------------------------------------------
// checkAndFireNudge — integration
// ---------------------------------------------------------------------------

describe("checkAndFireNudge", () => {
  test("no stats file → returns null", () => {
    const result = checkAndFireNudge(home);
    expect(result).toBeNull();
  });

  test("lifetime savings = 0 → returns null", async () => {
    await writeStats(0);
    const result = checkAndFireNudge(home);
    expect(result).toBeNull();
  });

  test("fires $5 threshold and dedupes on second call", async () => {
    const { costFor } = require("../servers/_pricing");
    const tokens = Math.ceil((5 / costFor(1_000_000)) * 1_000_000);
    await writeStats(tokens);

    const first = checkAndFireNudge(home);
    expect(first).not.toBeNull();
    expect(first).toContain("/ashlr-tier");

    // Second call — same threshold, already ticked.
    const second = checkAndFireNudge(home);
    expect(second).toBeNull();
  });

  test("fires session milestone for long session", async () => {
    // Small savings (below $ thresholds), session started 3h ago.
    const sessionStart = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    await writeStats(100, sessionStart, 50);

    const result = checkAndFireNudge(home);
    expect(result).not.toBeNull();
    expect(result).toContain("2h");
  });

  test("does not fire session milestone twice for same session", async () => {
    const sessionStart = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    await writeStats(100, sessionStart, 50);

    const first = checkAndFireNudge(home);
    expect(first).not.toBeNull();

    const second = checkAndFireNudge(home);
    expect(second).toBeNull();
  });
});
