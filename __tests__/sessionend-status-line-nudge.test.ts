/**
 * Unit tests for hooks/sessionend-status-line-nudge.ts
 *
 * Coverage matrix (per task):
 *   a. < 3 lifetime calls → no nudge.
 *   b. ≥ 3 calls AND status line not configured AND not previously fired → fires.
 *   c. ≥ 3 calls AND status line configured → no nudge.
 *   d. ≥ 3 calls AND not configured AND previously fired → no nudge.
 *   e. Nudge text includes the lifetime token count.
 *
 * Plus:
 *   - outside-discovery-window suppresses the nudge
 *   - explicit ashlr.statusLine=false counts as configured (opt-out)
 *   - missing stats.json → no nudge
 *   - end-to-end checkAndFireStatusLineNudge persists state on fire
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  STATUS_LINE_MIN_CALLS,
  STATUS_LINE_WINDOW_HOURS,
  buildStatusLineNudge,
  checkAndFireStatusLineNudge,
  computeStatusLineNudge,
  formatTokens,
  isStatusLineConfigured,
  readFirstRunAtMs,
  readStatsLite,
  readStatusLineNudgeState,
  statusLineNudgeStatePath,
  writeStatusLineNudgeState,
  type StatusLineNudgeState,
} from "../hooks/sessionend-status-line-nudge";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let home: string;
const nowMs = Date.parse("2026-05-22T12:00:00.000Z");
const firstRunRecent = new Date(nowMs - 60 * 60_000).toISOString(); // 1h ago
const firstRunOld = new Date(
  nowMs - (STATUS_LINE_WINDOW_HOURS + 1) * 60 * 60_000,
).toISOString();

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-statusline-nudge-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

async function writeStats(calls: number, tokensSaved: number): Promise<void> {
  const stats = {
    schemaVersion: 2,
    sessions: {},
    lifetime: { calls, tokensSaved, byTool: {}, byDay: {} },
  };
  await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(stats));
}

async function writeSessionState(firstRunAt: string): Promise<void> {
  const state = {
    firstRunAt,
    lastRunAt: firstRunAt,
    runCount: 1,
    lastWeeklySummaryAt: "",
  };
  await writeFile(
    join(home, ".ashlr", "session-state.json"),
    JSON.stringify(state),
  );
}

async function writeClaudeSettings(body: unknown): Promise<void> {
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify(body),
  );
}

const emptyState: StatusLineNudgeState = { last_status_line_nudge_at: 0 };

// ---------------------------------------------------------------------------
// Pure: text helpers
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
  test("zero / negative / nan → '0'", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-100)).toBe("0");
    expect(formatTokens(NaN)).toBe("0");
  });

  test("sub-1k → integer", () => {
    expect(formatTokens(420)).toBe("420");
  });

  test("k scale", () => {
    expect(formatTokens(1500)).toBe("1.5K");
  });

  test("m scale", () => {
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });
});

describe("buildStatusLineNudge", () => {
  test("includes formatted token count + install command + toggle hint", () => {
    const text = buildStatusLineNudge(12_345);
    expect(text).toContain("+12.3K tokens");
    expect(text).toContain("status bar");
    expect(text).toContain("/ashlr-settings install-status-line");
    expect(text).toContain("--set statusLine true");
  });
});

// ---------------------------------------------------------------------------
// Pure: decision (covers the requested matrix a–e)
// ---------------------------------------------------------------------------

describe("computeStatusLineNudge", () => {
  test("a) < MIN_CALLS lifetime → no nudge", () => {
    const r = computeStatusLineNudge({
      stats: { lifetimeCalls: STATUS_LINE_MIN_CALLS - 1, lifetimeTokensSaved: 9999 },
      firstRunAtMs: nowMs - 60_000,
      statusLineConfigured: false,
      state: emptyState,
      nowMs,
    });
    expect(r.nudgeText).toBeNull();
    expect(r.reason).toBe("below_min_calls");
  });

  test("b) ≥ MIN_CALLS + not configured + never fired → fires", () => {
    const r = computeStatusLineNudge({
      stats: { lifetimeCalls: STATUS_LINE_MIN_CALLS, lifetimeTokensSaved: 4200 },
      firstRunAtMs: nowMs - 60_000,
      statusLineConfigured: false,
      state: emptyState,
      nowMs,
    });
    expect(r.nudgeText).not.toBeNull();
    expect(r.reason).toBe("fired");
  });

  test("c) ≥ MIN_CALLS + status line configured → no nudge", () => {
    const r = computeStatusLineNudge({
      stats: { lifetimeCalls: 10, lifetimeTokensSaved: 50_000 },
      firstRunAtMs: nowMs - 60_000,
      statusLineConfigured: true,
      state: emptyState,
      nowMs,
    });
    expect(r.nudgeText).toBeNull();
    expect(r.reason).toBe("status_line_configured");
  });

  test("d) ≥ MIN_CALLS + not configured + already fired → no nudge", () => {
    const r = computeStatusLineNudge({
      stats: { lifetimeCalls: 10, lifetimeTokensSaved: 50_000 },
      firstRunAtMs: nowMs - 60_000,
      statusLineConfigured: false,
      state: { last_status_line_nudge_at: nowMs - 60 * 60_000 }, // fired 1h ago
      nowMs,
    });
    expect(r.nudgeText).toBeNull();
    expect(r.reason).toBe("already_fired");
  });

  test("e) nudge text includes the lifetime token count", () => {
    const r = computeStatusLineNudge({
      stats: { lifetimeCalls: 5, lifetimeTokensSaved: 9_876 },
      firstRunAtMs: nowMs - 60_000,
      statusLineConfigured: false,
      state: emptyState,
      nowMs,
    });
    expect(r.nudgeText).toContain("+9.9K");
  });

  test("outside the 24h discovery window → no nudge", () => {
    const r = computeStatusLineNudge({
      stats: { lifetimeCalls: 99, lifetimeTokensSaved: 1_000_000 },
      firstRunAtMs:
        nowMs - (STATUS_LINE_WINDOW_HOURS + 1) * 60 * 60_000, // > 24h
      statusLineConfigured: false,
      state: emptyState,
      nowMs,
    });
    expect(r.nudgeText).toBeNull();
    expect(r.reason).toBe("outside_discovery_window");
  });

  test("no stats file → no nudge", () => {
    const r = computeStatusLineNudge({
      stats: null,
      firstRunAtMs: nowMs - 60_000,
      statusLineConfigured: false,
      state: emptyState,
      nowMs,
    });
    expect(r.nudgeText).toBeNull();
    expect(r.reason).toBe("no_stats");
  });

  test("missing firstRunAt → still treats user as fresh (fires)", () => {
    const r = computeStatusLineNudge({
      stats: { lifetimeCalls: 5, lifetimeTokensSaved: 200 },
      firstRunAtMs: null,
      statusLineConfigured: false,
      state: emptyState,
      nowMs,
    });
    expect(r.nudgeText).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// File readers
// ---------------------------------------------------------------------------

describe("readStatsLite", () => {
  test("returns null when stats.json missing", () => {
    expect(readStatsLite(home)).toBeNull();
  });

  test("reads lifetime calls + tokensSaved", async () => {
    await writeStats(7, 12_500);
    const s = readStatsLite(home);
    expect(s).not.toBeNull();
    expect(s!.lifetimeCalls).toBe(7);
    expect(s!.lifetimeTokensSaved).toBe(12_500);
  });

  test("defaults to 0 when fields are missing", async () => {
    await writeFile(
      join(home, ".ashlr", "stats.json"),
      JSON.stringify({ schemaVersion: 2 }),
    );
    const s = readStatsLite(home);
    expect(s).not.toBeNull();
    expect(s!.lifetimeCalls).toBe(0);
    expect(s!.lifetimeTokensSaved).toBe(0);
  });
});

describe("readFirstRunAtMs", () => {
  test("returns null when session-state.json missing", () => {
    expect(readFirstRunAtMs(home)).toBeNull();
  });

  test("parses firstRunAt", async () => {
    await writeSessionState(firstRunRecent);
    const t = readFirstRunAtMs(home);
    expect(t).toBe(Date.parse(firstRunRecent));
  });
});

describe("isStatusLineConfigured", () => {
  test("no settings.json → false", () => {
    expect(isStatusLineConfigured(home)).toBe(false);
  });

  test("statusLine pointing elsewhere → false", async () => {
    await writeClaudeSettings({
      statusLine: { type: "command", command: "/usr/bin/some-other-thing" },
    });
    expect(isStatusLineConfigured(home)).toBe(false);
  });

  test("statusLine pointing at savings-status-line → true", async () => {
    await writeClaudeSettings({
      statusLine: {
        type: "command",
        command: "bun run /path/to/savings-status-line.ts",
      },
    });
    expect(isStatusLineConfigured(home)).toBe(true);
  });

  test("ashlr.statusLine=false counts as configured (opt-out)", async () => {
    await writeClaudeSettings({ ashlr: { statusLine: false } });
    expect(isStatusLineConfigured(home)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// State r/w
// ---------------------------------------------------------------------------

describe("status-line nudge state", () => {
  test("default when file missing", () => {
    const s = readStatusLineNudgeState(home);
    expect(s.last_status_line_nudge_at).toBe(0);
  });

  test("round-trip", () => {
    writeStatusLineNudgeState({ last_status_line_nudge_at: 12345 }, home);
    const s = readStatusLineNudgeState(home);
    expect(s.last_status_line_nudge_at).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator end-to-end
// ---------------------------------------------------------------------------

describe("checkAndFireStatusLineNudge (end-to-end)", () => {
  test("fires when all conditions are met + persists state", async () => {
    await writeStats(5, 8_888);
    await writeSessionState(firstRunRecent);
    // No settings.json → statusLine not configured.

    const r = checkAndFireStatusLineNudge(home, nowMs);
    expect(r.nudgeText).not.toBeNull();
    expect(r.nudgeText).toContain("8.9K");

    // State should be persisted so a second call is a no-op.
    const persisted = JSON.parse(
      await readFile(statusLineNudgeStatePath(home), "utf-8"),
    ) as StatusLineNudgeState;
    expect(persisted.last_status_line_nudge_at).toBe(nowMs);

    const r2 = checkAndFireStatusLineNudge(home, nowMs + 1000);
    expect(r2.nudgeText).toBeNull();
    expect(r2.reason).toBe("already_fired");
  });

  test("does not fire when status line is configured", async () => {
    await writeStats(5, 8_888);
    await writeSessionState(firstRunRecent);
    await writeClaudeSettings({
      statusLine: {
        type: "command",
        command: "bun run /path/to/savings-status-line.ts",
      },
    });

    const r = checkAndFireStatusLineNudge(home, nowMs);
    expect(r.nudgeText).toBeNull();
    expect(r.reason).toBe("status_line_configured");
  });

  test("does not fire below MIN_CALLS", async () => {
    await writeStats(STATUS_LINE_MIN_CALLS - 1, 100);
    await writeSessionState(firstRunRecent);

    const r = checkAndFireStatusLineNudge(home, nowMs);
    expect(r.nudgeText).toBeNull();
    expect(r.reason).toBe("below_min_calls");
  });

  test("does not fire outside the 24h window", async () => {
    await writeStats(99, 1_000_000);
    await writeSessionState(firstRunOld);

    const r = checkAndFireStatusLineNudge(home, nowMs);
    expect(r.nudgeText).toBeNull();
    expect(r.reason).toBe("outside_discovery_window");
  });
});
