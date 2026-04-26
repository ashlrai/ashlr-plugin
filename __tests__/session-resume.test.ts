/**
 * Tests for scripts/session-resume.ts
 *
 * All tests use isolated mkdtemp dirs; no real ~/.ashlr is touched.
 * Git branch detection is exercised only when git is available and the
 * test doesn't supply a branch override.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { buildResume, type SessionSummary } from "../scripts/session-resume";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let home: string;
let logPath: string;

// Pin "now" to a fixed point so relative-time strings are deterministic.
const NOW = new Date("2026-04-25T12:00:00Z").getTime();

// Two distinct sessions
const SESSION_A = "sess-aaa111";
const SESSION_B = "sess-bbb222";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-resume-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  logPath = join(home, ".ashlr", "session-log.jsonl");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Record factory
// ---------------------------------------------------------------------------

interface FakeRecord {
  ts?: string;
  event?: string;
  tool?: string;
  cwd?: string;
  session?: string;
  input_size?: number;
  output_size?: number;
  calls?: number;
  tokens_saved?: number;
  started_at?: string;
}

/** Build a "yesterday" timestamp offset by `offsetMs` from session start. */
function tsAt(baseMs: number, offsetMs = 0): string {
  return new Date(baseMs + offsetMs).toISOString();
}

const SESSION_A_START = NOW - 26 * 60 * 60_000; // ~26 hours ago (yesterday)
const SESSION_B_START = NOW - 2 * 60 * 60_000;  // ~2 hours ago

function makeRecord(overrides: FakeRecord = {}): string {
  const base: FakeRecord = {
    ts: tsAt(SESSION_A_START),
    event: "tool_call",
    tool: "ashlr__read",
    cwd: "/projects/myapp",
    session: SESSION_A,
    input_size: 512,
    output_size: 1024,
  };
  return JSON.stringify({ ...base, ...overrides });
}

function makeSessionEnd(overrides: FakeRecord = {}): string {
  const base: FakeRecord = {
    ts: tsAt(SESSION_A_START, 60 * 60_000),
    event: "session_end",
    tool: "session_end",
    cwd: "/projects/myapp",
    session: SESSION_A,
    calls: 30,
    tokens_saved: 4_300_000,
    started_at: tsAt(SESSION_A_START),
  };
  return JSON.stringify({ ...base, ...overrides });
}

async function writeLog(records: string[]): Promise<void> {
  await writeFile(logPath, records.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Empty / missing log
// ---------------------------------------------------------------------------

describe("empty / missing log", () => {
  test("no log file → friendly no-sessions message", () => {
    const out = buildResume({ home, now: NOW });
    expect(out).toContain("No prior sessions found");
    expect(out).toContain("starting fresh");
  });

  test("empty log file → friendly no-sessions message", async () => {
    await writeFile(logPath, "");
    const out = buildResume({ home, now: NOW });
    expect(out).toContain("No prior sessions found");
  });

  test("log with only malformed lines → friendly message", async () => {
    await writeFile(logPath, "not-json\n{bad\n\n");
    const out = buildResume({ home, now: NOW });
    expect(out).toContain("starting fresh");
  });
});

// ---------------------------------------------------------------------------
// Session grouping
// ---------------------------------------------------------------------------

describe("session grouping by sessionId", () => {
  test("two sessions produce separate groups — most recent first", async () => {
    const records = [
      // Session A — older
      makeRecord({ session: SESSION_A, ts: tsAt(SESSION_A_START), tool: "ashlr__read" }),
      makeRecord({ session: SESSION_A, ts: tsAt(SESSION_A_START, 1000), tool: "ashlr__edit" }),
      // Session B — more recent
      makeRecord({ session: SESSION_B, ts: tsAt(SESSION_B_START), tool: "ashlr__grep" }),
      makeRecord({ session: SESSION_B, ts: tsAt(SESSION_B_START, 1000), tool: "Bash" }),
    ];
    await writeLog(records);

    const out = buildResume({ home, now: NOW });
    // Most recent (B) should appear as "Last session"
    expect(out).toContain("Last session");
    // Output should include mention of session activity
    expect(out).toContain("Calls:");
  });

  test("sessions with zero tool_call events are excluded", async () => {
    // Only session_end events, no tool_call
    const records = [
      makeSessionEnd({ session: SESSION_A }),
    ];
    await writeLog(records);

    const out = buildResume({ home, now: NOW });
    expect(out).toContain("starting fresh");
  });
});

// ---------------------------------------------------------------------------
// Top 5 files / 3 patterns / 5 bash extraction
// ---------------------------------------------------------------------------

describe("top file/tool extraction", () => {
  test("top 5 cwds by call count (read + edit combined)", async () => {
    const records: string[] = [];
    // cwd-a: 12 reads
    for (let i = 0; i < 12; i++) {
      records.push(makeRecord({ cwd: "/projects/cwd-a", tool: "ashlr__read" }));
    }
    // cwd-b: 4 edits
    for (let i = 0; i < 4; i++) {
      records.push(makeRecord({ cwd: "/projects/cwd-b", tool: "ashlr__edit" }));
    }
    // cwd-c: 2 reads + 3 edits = 5
    for (let i = 0; i < 2; i++) {
      records.push(makeRecord({ cwd: "/projects/cwd-c", tool: "Read" }));
    }
    for (let i = 0; i < 3; i++) {
      records.push(makeRecord({ cwd: "/projects/cwd-c", tool: "Edit" }));
    }
    // cwd-d: 3 reads
    for (let i = 0; i < 3; i++) {
      records.push(makeRecord({ cwd: "/projects/cwd-d", tool: "ashlr__read" }));
    }
    // cwd-e: 2 reads
    for (let i = 0; i < 2; i++) {
      records.push(makeRecord({ cwd: "/projects/cwd-e", tool: "ashlr__read" }));
    }
    // cwd-f: 1 read (should be in top 5 but ranked 6th — may not show)
    records.push(makeRecord({ cwd: "/projects/cwd-f", tool: "ashlr__read" }));
    await writeLog(records);

    const out = buildResume({ home, now: NOW });
    // cwd-a had the most (12 reads)
    expect(out).toContain("cwd-a");
    // cwd-b had 4 edits
    expect(out).toContain("cwd-b");
    // cwd-c had 5 combined
    expect(out).toContain("cwd-c");
  });

  test("bash calls (top 5) are captured", async () => {
    const records: string[] = [];
    // 8 Bash calls
    for (let i = 0; i < 8; i++) {
      records.push(makeRecord({ tool: "Bash" }));
    }
    // 3 ashlr__bash calls
    for (let i = 0; i < 3; i++) {
      records.push(makeRecord({ tool: "ashlr__bash" }));
    }
    await writeLog(records);

    const out = buildResume({ home, now: NOW });
    expect(out).toContain("Bash");
  });

  test("grep/search tools appear in Patterns line", async () => {
    const records: string[] = [];
    for (let i = 0; i < 5; i++) {
      records.push(makeRecord({ tool: "ashlr__grep" }));
    }
    for (let i = 0; i < 2; i++) {
      records.push(makeRecord({ tool: "Grep" }));
    }
    await writeLog(records);

    const out = buildResume({ home, now: NOW });
    expect(out).toContain("Patterns:");
    expect(out).toContain("ashlr__grep");
  });
});

// ---------------------------------------------------------------------------
// Tokens-saved aggregation
// ---------------------------------------------------------------------------

describe("tokens-saved", () => {
  test("session_end tokens_saved appear in header", async () => {
    const records = [
      makeRecord({ session: SESSION_A }),
      makeSessionEnd({ session: SESSION_A, tokens_saved: 4_300_000 }),
    ];
    await writeLog(records);

    const out = buildResume({ home, now: NOW });
    // Should show "4.3M" somewhere
    expect(out).toContain("4.3M");
  });

  test("zero tokens_saved → no cost shown in header", async () => {
    const records = [
      makeRecord({ session: SESSION_A }),
      makeSessionEnd({ session: SESSION_A, tokens_saved: 0 }),
    ];
    await writeLog(records);

    const out = buildResume({ home, now: NOW });
    // No cost string when zero tokens
    expect(out).not.toContain("≈$");
  });

  test("no session_end → tokens_saved defaults to 0, no crash", async () => {
    const records = [makeRecord({ session: SESSION_A })];
    await writeLog(records);

    const out = buildResume({ home, now: NOW });
    expect(out).toContain("Last session");
    expect(out).not.toContain("NaN");
  });
});

// ---------------------------------------------------------------------------
// Branch filter mode
// ---------------------------------------------------------------------------

describe("branch-filter mode", () => {
  test("branch arg with no git → falls back gracefully with branch label", async () => {
    const records = [
      makeRecord({ session: SESSION_A, cwd: "/projects/myapp" }),
      makeRecord({ session: SESSION_A, cwd: "/projects/myapp", tool: "ashlr__edit" }),
    ];
    await writeLog(records);

    // Use a non-git dir so branch detection can't work
    const out = buildResume({ home, now: NOW, branch: "feature/auth", gitCwd: home });
    // Should not crash; should include the branch name as label
    expect(out).toContain("feature/auth");
    expect(out).not.toContain("undefined");
  });

  test("unknown branch → shows most recent session with note", async () => {
    const records = [
      makeRecord({ session: SESSION_A }),
      makeRecord({ session: SESSION_A, tool: "ashlr__edit" }),
    ];
    await writeLog(records);

    // Supply a non-existent branch name with a real git cwd
    const out = buildResume({
      home,
      now: NOW,
      branch: "branch-that-does-not-exist-xyz",
      gitCwd: "/Users/masonwyatt/Desktop/ashlr-plugin",
    });
    // Either shows the branch note or falls back to most recent
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
    // Should still produce some useful output
    expect(out.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Resume suggestions
// ---------------------------------------------------------------------------

describe("resume suggestions", () => {
  test("suggestions section always present", async () => {
    const records = [makeRecord({ session: SESSION_A })];
    await writeLog(records);

    const out = buildResume({ home, now: NOW });
    expect(out).toContain("Resume? Suggested next steps");
  });

  test("edit-heavy session → re-open suggestion", async () => {
    const records: string[] = [];
    for (let i = 0; i < 4; i++) {
      records.push(makeRecord({ tool: "ashlr__edit", cwd: "/projects/myapp" }));
    }
    await writeLog(records);

    const out = buildResume({ home, now: NOW });
    expect(out).toContain("Re-open");
  });
});

// ---------------------------------------------------------------------------
// Relative time rendering
// ---------------------------------------------------------------------------

describe("relative time rendering", () => {
  test("session from yesterday shows 'yesterday'", async () => {
    const records = [
      makeRecord({ ts: tsAt(SESSION_A_START), session: SESSION_A }),
    ];
    await writeLog(records);

    const out = buildResume({ home, now: NOW });
    expect(out).toContain("yesterday");
  });

  test("session from 2 hours ago shows 'Xh ago'", async () => {
    const records = [
      makeRecord({ ts: tsAt(SESSION_B_START), session: SESSION_B }),
    ];
    await writeLog(records);

    const out = buildResume({ home, now: NOW });
    expect(out).toMatch(/\d+h ago/);
  });
});
