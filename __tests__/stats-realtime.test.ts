/**
 * Real-time accuracy tests for the stats + status-line pipeline.
 *
 * Goals:
 *   1. Cross-terminal lifetime freshness: a recordSaving in "terminal A"
 *      (simulated by sessionId "A") is visible to "terminal B"'s status-line
 *      read within 500ms.
 *   2. Per-session isolation: terminal A's session bump is NOT visible in
 *      terminal B's session bucket.
 *   3. Flush-on-exit hardening: pending debounced state that hasn't reached
 *      disk survives a simulated process exit (beforeExit / exit drain).
 *
 * All tests run with ASHLR_STATS_SYNC=1 to avoid flakiness from debounce
 * timing in CI. The realtime latency test explicitly uses debounce mode
 * (deletes ASHLR_STATS_SYNC) and measures wall-clock time.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  _drainWrites,
  _resetMemCache,
  _resetWriteCount,
  recordSaving,
  readStats,
  statsPath,
} from "../servers/_stats";
import { buildStatusLine, _resetReadCache } from "../scripts/savings-status-line";

let home: string;
const originalHome = process.env.HOME;
const originalSession = process.env.CLAUDE_SESSION_ID;
const originalSync = process.env.ASHLR_STATS_SYNC;

const SID_A = "realtime-session-A";
const SID_B = "realtime-session-B";

const BASE_ENV = Object.freeze({
  NO_COLOR: "1",
  ASHLR_STATUS_ANIMATE: "0",
  COLUMNS: "120",
}) as Readonly<NodeJS.ProcessEnv>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-realtime-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  process.env.HOME = home;
  process.env.ASHLR_STATS_SYNC = "1";
  _resetMemCache();
  _resetReadCache();
  _resetWriteCount();
});

afterEach(async () => {
  await _drainWrites();
  process.env.HOME = originalHome;
  if (originalSession !== undefined) process.env.CLAUDE_SESSION_ID = originalSession;
  else delete process.env.CLAUDE_SESSION_ID;
  if (originalSync !== undefined) process.env.ASHLR_STATS_SYNC = originalSync;
  else delete process.env.ASHLR_STATS_SYNC;
  _resetMemCache();
  _resetReadCache();
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: read lifetime from status line for a given session id
// ---------------------------------------------------------------------------

function readStatusLineNumbers(sessionId: string): { session: number; lifetime: number } {
  _resetReadCache(); // force disk read so we see the latest file
  const env = { ...BASE_ENV, CLAUDE_SESSION_ID: sessionId, HOME: home };
  const line = buildStatusLine({ home, env });
  // Strip ANSI escapes so we can parse cleanly.
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");

  function parseTokens(segment: string): number {
    const m = segment.match(/([\d.]+)([KM]?)/);
    if (!m) return 0;
    const v = parseFloat(m[1]!);
    if (m[2] === "K") return Math.round(v * 1000);
    if (m[2] === "M") return Math.round(v * 1_000_000);
    return Math.round(v);
  }

  const sessMatch = plain.match(/session [↑+]?\+([^\s·]+)/);
  const lifeMatch = plain.match(/lifetime \+([^\s·]+)/);
  return {
    session:  sessMatch  ? parseTokens(sessMatch[1]!)  : 0,
    lifetime: lifeMatch  ? parseTokens(lifeMatch[1]!)  : 0,
  };
}

// ---------------------------------------------------------------------------
// 1. Cross-terminal lifetime freshness
// ---------------------------------------------------------------------------

describe("cross-terminal freshness", () => {
  test("terminal A's saving is visible to terminal B's status line within 500ms", async () => {
    const start = Date.now();

    // Terminal A records a saving (sync mode — hits disk immediately).
    await recordSaving(40_000, 4_000, "ashlr__read", { sessionId: SID_A });

    // Terminal B reads status line — cache is cleared so it goes to disk.
    const { lifetime: lifetimeFromB } = readStatusLineNumbers(SID_B);

    const elapsed = Date.now() - start;

    // The lifetime total should reflect A's save.
    expect(lifetimeFromB).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });

  test("multiple saves from A accumulate in lifetime visible to B", async () => {
    for (let i = 0; i < 5; i++) {
      await recordSaving(8_000, 800, "ashlr__read", { sessionId: SID_A });
    }
    const { lifetime } = readStatusLineNumbers(SID_B);
    // 5 × ceil((8000-800)/4) = 5 × 1800 = 9000 tokens
    expect(lifetime).toBeGreaterThanOrEqual(9_000);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-session isolation
// ---------------------------------------------------------------------------

describe("per-session isolation", () => {
  test("terminal A's session counter is NOT visible in terminal B", async () => {
    await recordSaving(40_000, 4_000, "ashlr__read", { sessionId: SID_A });

    // B should see 0 for its own session (it never recorded anything).
    const { session: sessionB } = readStatusLineNumbers(SID_B);
    expect(sessionB).toBe(0);
  });

  test("terminal A's session counter IS visible when reading as A", async () => {
    await recordSaving(40_000, 4_000, "ashlr__read", { sessionId: SID_A });

    const { session: sessionA } = readStatusLineNumbers(SID_A);
    expect(sessionA).toBeGreaterThan(0);
  });

  test("both sessions accumulate in lifetime but not in each other's session bucket", async () => {
    await recordSaving(20_000, 2_000, "ashlr__read", { sessionId: SID_A });
    await recordSaving(20_000, 2_000, "ashlr__read", { sessionId: SID_B });

    const { session: sessA, lifetime: lifeA } = readStatusLineNumbers(SID_A);
    const { session: sessB, lifetime: lifeB } = readStatusLineNumbers(SID_B);

    // Each session only sees its own tokens.
    expect(sessA).toBeGreaterThan(0);
    expect(sessB).toBeGreaterThan(0);
    // Both should see the same (combined) lifetime.
    expect(lifeA).toEqual(lifeB);
    // Lifetime is the sum of both sessions.
    expect(lifeA).toBeGreaterThanOrEqual(sessA + sessB);
  });
});

// ---------------------------------------------------------------------------
// 3. Flush-on-exit hardening
// ---------------------------------------------------------------------------

describe("flush-on-exit hardening", () => {
  test("pending debounced delta survives simulated process exit", async () => {
    // Switch to debounce mode to create a pending flush.
    delete process.env.ASHLR_STATS_SYNC;
    _resetMemCache();

    process.env.CLAUDE_SESSION_ID = SID_A;

    // Record savings without waiting for flush — delta is in-memory only.
    for (let i = 0; i < 5; i++) {
      await recordSaving(4_000, 400, "ashlr__read");
    }

    // Simulate process exit: drain exactly as the exit handlers do.
    await _drainWrites();

    // Now verify the data made it to disk.
    _resetMemCache();
    const stats = await readStats();
    expect(stats.sessions[SID_A]?.calls).toBe(5);
    expect(stats.lifetime.calls).toBeGreaterThanOrEqual(5);
  });

  test("flushToDiskSync written data is readable after _resetMemCache", async () => {
    delete process.env.ASHLR_STATS_SYNC;
    _resetMemCache();

    process.env.CLAUDE_SESSION_ID = SID_A;

    await recordSaving(10_000, 1_000, "ashlr__read");

    // Drain to simulate beforeExit.
    await _drainWrites();

    // Verify the file exists and is valid JSON.
    const raw = await readFile(join(home, ".ashlr", "stats.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.sessions[SID_A]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. Debounce latency measurement (non-sync mode)
// ---------------------------------------------------------------------------

describe("debounce latency", () => {
  test("recordSaving visible in status line within 550ms (debounce + cache TTL)", async () => {
    delete process.env.ASHLR_STATS_SYNC;
    _resetMemCache();
    _resetReadCache();

    process.env.CLAUDE_SESSION_ID = SID_A;

    // Windows hosted CI runners have slower spawn + filesystem latency; widen
    // the polling deadline AND the wall-clock assertion proportionally so the
    // test still validates "visible within debounce window" without flaking.
    const isWin = process.platform === "win32";
    const deadlineMs = isWin ? 1500 : 550;
    const wallClockMs = isWin ? 1600 : 600;

    const t0 = Date.now();
    // Record — goes to in-memory pending state, schedules 250ms flush.
    await recordSaving(40_000, 4_000, "ashlr__read");

    // Poll until the status line reflects the change or we exceed the deadline.
    const deadline = t0 + deadlineMs;
    let visible = false;
    while (Date.now() < deadline) {
      _resetReadCache();
      const { session } = readStatusLineNumbers(SID_A);
      if (session > 0) { visible = true; break; }
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(visible).toBe(true);
    expect(Date.now() - t0).toBeLessThan(wallClockMs);
  });
});
