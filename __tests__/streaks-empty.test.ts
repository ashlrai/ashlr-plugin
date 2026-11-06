/**
 * Tests for the empty-activity path in _streaks.ts
 *
 * Acceptance: when there is no prior activity (fresh install, no streaks.json),
 * the documented streak result is produced. Exercises readStreaks on a missing
 * file, computeNewStreak with the zero-state, rendering with zero streak, and
 * the full bumpStreak round-trip from a clean home.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  bumpStreak,
  computeNewStreak,
  readStreaks,
  renderStreakBadge,
  renderStreakLabel,
  todayKey,
  type StreakData,
} from "../servers/_streaks";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-streaks-empty-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Empty state — no prior data
// ---------------------------------------------------------------------------

describe("empty activity produces the documented streak result", () => {
  const empty: StreakData = { currentStreak: 0, longestStreak: 0, lastActiveDay: "" };

  test("readStreaks with no file returns zero-state", () => {
    const d = readStreaks(home);
    expect(d.currentStreak).toBe(0);
    expect(d.longestStreak).toBe(0);
    expect(d.lastActiveDay).toBe("");
  });

  test("computeNewStreak on zero-state produces streak of 1", () => {
    const result = computeNewStreak(empty, "2026-05-01");
    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(1);
    expect(result.lastActiveDay).toBe("2026-05-01");
  });

  test("computeNewStreak with empty today key returns data unchanged", () => {
    const result = computeNewStreak(empty, "");
    expect(result).toEqual(empty);
  });

  test("renderStreakLabel on zero streak returns empty string", () => {
    expect(renderStreakLabel(empty)).toBe("");
  });

  test("renderStreakBadge on zero streak returns empty string", () => {
    expect(renderStreakBadge(empty)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Full round-trip: clean home → bumpStreak → read back
// ---------------------------------------------------------------------------

describe("bumpStreak from a clean home", () => {
  test("first bump creates streak of 1 and writes file", () => {
    const nowMs = Date.parse("2026-06-15T08:00:00Z");
    bumpStreak(home, nowMs);
    const d = readStreaks(home);
    expect(d.currentStreak).toBe(1);
    expect(d.longestStreak).toBe(1);
    expect(d.lastActiveDay).toBe(todayKey(nowMs));
  });

  test("readStreaks after first bump matches computed result", () => {
    const nowMs = Date.parse("2026-06-15T08:00:00Z");
    bumpStreak(home, nowMs);
    const d = readStreaks(home);
    const expected = computeNewStreak(
      { currentStreak: 0, longestStreak: 0, lastActiveDay: "" },
      todayKey(nowMs)
    );
    expect(d).toEqual(expected);
  });
});
