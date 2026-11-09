/**
 * Unit tests for _streaks.ts
 *
 * Exercises streak increment, grace-period, reset, IO, and the status-line
 * badge surface. Tests use a tmp HOME so the real ~/.ashlr/streaks.json is
 * never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  bumpStreak,
  computeNewStreak,
  daysBetween,
  readStreaks,
  renderStreakBadge,
  renderStreakLabel,
  streakPath,
  todayKey,
  writeStreaks,
  type StreakData,
} from "../servers/_streaks";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-streaks-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("todayKey", () => {
  test("returns YYYY-MM-DD", () => {
    const k = todayKey(Date.parse("2026-04-25T12:00:00Z"));
    expect(k).toBe("2026-04-25");
  });
});

describe("daysBetween", () => {
  test("same day → 0", () => {
    expect(daysBetween("2026-04-25", "2026-04-25")).toBe(0);
  });
  test("consecutive days → 1", () => {
    expect(daysBetween("2026-04-24", "2026-04-25")).toBe(1);
  });
  test("2-day gap → 2", () => {
    expect(daysBetween("2026-04-23", "2026-04-25")).toBe(2);
  });
  test("order-independent (absolute)", () => {
    expect(daysBetween("2026-04-25", "2026-04-23")).toBe(2);
  });
  test("invalid date → Infinity", () => {
    expect(daysBetween("not-a-date", "2026-04-25")).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// computeNewStreak — core logic
// ---------------------------------------------------------------------------

describe("computeNewStreak", () => {
  const empty: StreakData = { currentStreak: 0, longestStreak: 0, lastActiveDay: "" };
  const streak5: StreakData = { currentStreak: 5, longestStreak: 10, lastActiveDay: "2026-04-24" };

  test("no prior active day → streak becomes 1", () => {
    const r = computeNewStreak(empty, "2026-04-25");
    expect(r.currentStreak).toBe(1);
    expect(r.longestStreak).toBe(1);
    expect(r.lastActiveDay).toBe("2026-04-25");
  });

  test("same day → idempotent (no change)", () => {
    const data: StreakData = { currentStreak: 3, longestStreak: 5, lastActiveDay: "2026-04-25" };
    const r = computeNewStreak(data, "2026-04-25");
    expect(r.currentStreak).toBe(3);
    expect(r.lastActiveDay).toBe("2026-04-25");
  });

  test("consecutive day (gap=1) → increments streak", () => {
    const r = computeNewStreak(streak5, "2026-04-25");
    expect(r.currentStreak).toBe(6);
    expect(r.lastActiveDay).toBe("2026-04-25");
  });

  test("grace: 1-day gap (gap=2) → still increments", () => {
    // lastActiveDay 2 days ago → grace allows extending.
    const data: StreakData = { currentStreak: 4, longestStreak: 8, lastActiveDay: "2026-04-23" };
    const r = computeNewStreak(data, "2026-04-25");
    expect(r.currentStreak).toBe(5);
  });

  test("2+ day gap (gap=3) → resets to 1", () => {
    const data: StreakData = { currentStreak: 7, longestStreak: 7, lastActiveDay: "2026-04-22" };
    const r = computeNewStreak(data, "2026-04-25");
    expect(r.currentStreak).toBe(1);
  });

  test("longestStreak updated when currentStreak exceeds it", () => {
    const data: StreakData = { currentStreak: 10, longestStreak: 10, lastActiveDay: "2026-04-24" };
    const r = computeNewStreak(data, "2026-04-25");
    expect(r.currentStreak).toBe(11);
    expect(r.longestStreak).toBe(11);
  });

  test("longestStreak preserved when currentStreak does not exceed it", () => {
    const r = computeNewStreak(streak5, "2026-04-25"); // streak5.longestStreak=10
    expect(r.currentStreak).toBe(6);
    expect(r.longestStreak).toBe(10);
  });

  test("reset: longestStreak preserved after reset", () => {
    const data: StreakData = { currentStreak: 3, longestStreak: 15, lastActiveDay: "2026-04-01" };
    const r = computeNewStreak(data, "2026-04-25");
    expect(r.currentStreak).toBe(1);
    expect(r.longestStreak).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// IO round-trip
// ---------------------------------------------------------------------------

describe("readStreaks / writeStreaks", () => {
  test("missing file → returns zeros", () => {
    const d = readStreaks(home);
    expect(d.currentStreak).toBe(0);
    expect(d.longestStreak).toBe(0);
    expect(d.lastActiveDay).toBe("");
  });

  test("round-trip write/read", () => {
    const payload: StreakData = { currentStreak: 5, longestStreak: 12, lastActiveDay: "2026-04-25" };
    writeStreaks(payload, home);
    const back = readStreaks(home);
    expect(back.currentStreak).toBe(5);
    expect(back.longestStreak).toBe(12);
    expect(back.lastActiveDay).toBe("2026-04-25");
  });

  test("corrupt file → returns zeros gracefully", async () => {
    const { writeFile } = await import("fs/promises");
    await writeFile(join(home, ".ashlr", "streaks.json"), "{corrupt");
    const d = readStreaks(home);
    expect(d.currentStreak).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Persistence in an isolated temporary home
// ---------------------------------------------------------------------------

describe("streak persistence", () => {
  test("streakPath lives under <home>/.ashlr/streaks.json", () => {
    expect(streakPath(home)).toBe(join(home, ".ashlr", "streaks.json"));
  });

  test("written streak is stored as JSON with every field intact", async () => {
    const payload: StreakData = { currentStreak: 7, longestStreak: 21, lastActiveDay: "2026-04-25" };
    writeStreaks(payload, home);
    expect(existsSync(streakPath(home))).toBe(true);
    const onDisk = JSON.parse(await readFile(streakPath(home), "utf-8"));
    expect(onDisk).toEqual(payload);
    expect(readStreaks(home)).toEqual(payload);
  });

  test("write creates the .ashlr directory when the home is fresh", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "ashlr-streaks-fresh-"));
    try {
      expect(existsSync(join(fresh, ".ashlr"))).toBe(false);
      const payload: StreakData = { currentStreak: 1, longestStreak: 4, lastActiveDay: "2026-01-02" };
      writeStreaks(payload, fresh);
      expect(readStreaks(fresh)).toEqual(payload);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  test("a second write replaces the first", () => {
    writeStreaks({ currentStreak: 2, longestStreak: 2, lastActiveDay: "2026-04-24" }, home);
    const next: StreakData = { currentStreak: 3, longestStreak: 3, lastActiveDay: "2026-04-25" };
    writeStreaks(next, home);
    expect(readStreaks(home)).toEqual(next);
  });

  test("zero values and empty lastActiveDay survive a round trip", () => {
    const zero: StreakData = { currentStreak: 0, longestStreak: 0, lastActiveDay: "" };
    writeStreaks(zero, home);
    expect(readStreaks(home)).toEqual(zero);
  });

  test("bumpStreak persists computed fields that a fresh read sees", () => {
    writeStreaks({ currentStreak: 4, longestStreak: 9, lastActiveDay: "2026-04-24" }, home);
    bumpStreak(home, Date.parse("2026-04-25T08:00:00Z"));
    const raw = JSON.parse(readFileSync(streakPath(home), "utf-8"));
    expect(raw).toEqual({ currentStreak: 5, longestStreak: 9, lastActiveDay: "2026-04-25" });
  });

  test("same-day bump leaves the file byte-for-byte unchanged", () => {
    writeStreaks({ currentStreak: 4, longestStreak: 9, lastActiveDay: "2026-04-25" }, home);
    const before = readFileSync(streakPath(home), "utf-8");
    bumpStreak(home, Date.parse("2026-04-25T23:00:00Z"));
    expect(readFileSync(streakPath(home), "utf-8")).toBe(before);
  });

  test("wrong-typed or missing fields fall back to defaults per field", async () => {
    await writeFile(
      streakPath(home),
      JSON.stringify({ currentStreak: "5", longestStreak: 8, lastActiveDay: 20260425 }),
    );
    expect(readStreaks(home)).toEqual({ currentStreak: 0, longestStreak: 8, lastActiveDay: "" });
  });
});

// ---------------------------------------------------------------------------
// bumpStreak — integration (reads + writes)
// ---------------------------------------------------------------------------

describe("bumpStreak", () => {
  test("first call → currentStreak=1", () => {
    const nowMs = Date.parse("2026-04-25T10:00:00Z");
    bumpStreak(home, nowMs);
    const d = readStreaks(home);
    expect(d.currentStreak).toBe(1);
    expect(d.lastActiveDay).toBe("2026-04-25");
  });

  test("called twice same day → idempotent", () => {
    const nowMs = Date.parse("2026-04-25T10:00:00Z");
    bumpStreak(home, nowMs);
    bumpStreak(home, nowMs + 3600_000);
    const d = readStreaks(home);
    expect(d.currentStreak).toBe(1); // still 1, not 2
  });

  test("multiple events per day count once across consecutive days", () => {
    for (const timestamp of [
      "2026-04-24T00:00:00Z",
      "2026-04-24T12:00:00Z",
      "2026-04-24T23:59:59Z",
    ]) {
      bumpStreak(home, Date.parse(timestamp));
    }
    expect(readStreaks(home)).toEqual({
      currentStreak: 1,
      longestStreak: 1,
      lastActiveDay: "2026-04-24",
    });

    for (const timestamp of ["2026-04-25T00:00:00Z", "2026-04-25T18:00:00Z"]) {
      bumpStreak(home, Date.parse(timestamp));
    }
    expect(readStreaks(home)).toEqual({
      currentStreak: 2,
      longestStreak: 2,
      lastActiveDay: "2026-04-25",
    });
  });

  test("next day → increments streak", () => {
    bumpStreak(home, Date.parse("2026-04-24T10:00:00Z"));
    bumpStreak(home, Date.parse("2026-04-25T10:00:00Z"));
    const d = readStreaks(home);
    expect(d.currentStreak).toBe(2);
  });

  test("grace: skip 1 day still extends streak", () => {
    bumpStreak(home, Date.parse("2026-04-23T10:00:00Z"));
    bumpStreak(home, Date.parse("2026-04-25T10:00:00Z")); // skip Apr 24
    const d = readStreaks(home);
    expect(d.currentStreak).toBe(2);
  });

  test("skip 2 days resets streak to 1", () => {
    bumpStreak(home, Date.parse("2026-04-22T10:00:00Z"));
    bumpStreak(home, Date.parse("2026-04-25T10:00:00Z")); // 3-day gap
    const d = readStreaks(home);
    expect(d.currentStreak).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

describe("renderStreakLabel / renderStreakBadge", () => {
  test("streak < 3 → empty string", () => {
    const d: StreakData = { currentStreak: 2, longestStreak: 2, lastActiveDay: "2026-04-25" };
    expect(renderStreakLabel(d)).toBe("");
    expect(renderStreakBadge(d)).toBe("");
  });

  test("streak = 3 → shows label", () => {
    const d: StreakData = { currentStreak: 3, longestStreak: 3, lastActiveDay: "2026-04-25" };
    expect(renderStreakLabel(d)).toBe("3d streak");
    expect(renderStreakBadge(d)).toBe("* 3d streak");
  });

  test("streak = 5 → shows 5d", () => {
    const d: StreakData = { currentStreak: 5, longestStreak: 12, lastActiveDay: "2026-04-25" };
    expect(renderStreakLabel(d)).toBe("5d streak");
    expect(renderStreakBadge(d)).toBe("* 5d streak");
  });
});

// ---------------------------------------------------------------------------
// Status-line surface — streak badge appears in buildStatusLine output
// ---------------------------------------------------------------------------

describe("streak badge in status-line", () => {
  test("streak >= 3 → badge appears in status line", async () => {
    const { writeFile } = await import("fs/promises");
    // Write a valid stats file.
    const stats = {
      schemaVersion: 2,
      sessions: {
        "test-sid": {
          startedAt: new Date().toISOString(),
          lastSavingAt: null,
          calls: 10,
          tokensSaved: 5000,
          byTool: {},
        },
      },
      lifetime: { calls: 50, tokensSaved: 50_000, byTool: {}, byDay: {} },
    };
    await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(stats));
    writeStreaks({ currentStreak: 5, longestStreak: 10, lastActiveDay: "2026-04-25" }, home);

    const { buildStatusLine, _resetReadCache } = await import("../scripts/savings-status-line");
    _resetReadCache();
    const line = buildStatusLine({
      home,
      budget: 200,
      env: {
        NO_COLOR: "1",
        ASHLR_STATUS_ANIMATE: "0",
        CLAUDE_SESSION_ID: "test-sid",
        COLUMNS: "200",
        ASHLR_DISABLE_MILESTONES: "1",
      },
      suppressMilestoneSideEffects: true,
    });
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("5d streak");
  });

  test("streak < 3 → no badge in status line", async () => {
    const { writeFile } = await import("fs/promises");
    const stats = {
      schemaVersion: 2,
      sessions: {
        "test-sid": { startedAt: new Date().toISOString(), lastSavingAt: null, calls: 5, tokensSaved: 1000, byTool: {} },
      },
      lifetime: { calls: 20, tokensSaved: 1000, byTool: {}, byDay: {} },
    };
    await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(stats));
    writeStreaks({ currentStreak: 2, longestStreak: 5, lastActiveDay: "2026-04-25" }, home);

    const { buildStatusLine, _resetReadCache } = await import("../scripts/savings-status-line");
    _resetReadCache();
    const line = buildStatusLine({
      home,
      budget: 200,
      env: { NO_COLOR: "1", ASHLR_STATUS_ANIMATE: "0", CLAUDE_SESSION_ID: "test-sid", COLUMNS: "200", ASHLR_DISABLE_MILESTONES: "1" },
      suppressMilestoneSideEffects: true,
    });
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).not.toContain("streak");
  });
});
