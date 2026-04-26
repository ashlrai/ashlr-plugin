/**
 * _streaks.ts — Saving-streak tracking for the ashlr-plugin.
 *
 * Persists to ~/.ashlr/streaks.json:
 *   { currentStreak: N, longestStreak: M, lastActiveDay: "YYYY-MM-DD" }
 *
 * Called by recordSaving (gated to once-per-day to avoid hot-path overhead).
 * Read by the status-line, dashboard, and savings-report surfaces.
 *
 * Grace rule: a 1-day gap does NOT break the streak (life happens).
 * A 2+ day gap resets currentStreak to 1.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreakData {
  currentStreak: number;
  longestStreak: number;
  lastActiveDay: string; // YYYY-MM-DD UTC
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function streakPath(home: string = homedir()): string {
  return join(home, ".ashlr", "streaks.json");
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

export function readStreaks(home: string = homedir()): StreakData {
  try {
    const p = streakPath(home);
    if (!existsSync(p)) return { currentStreak: 0, longestStreak: 0, lastActiveDay: "" };
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<StreakData>;
    return {
      currentStreak: typeof raw.currentStreak === "number" ? raw.currentStreak : 0,
      longestStreak: typeof raw.longestStreak === "number" ? raw.longestStreak : 0,
      lastActiveDay: typeof raw.lastActiveDay === "string" ? raw.lastActiveDay : "",
    };
  } catch {
    return { currentStreak: 0, longestStreak: 0, lastActiveDay: "" };
  }
}

export function writeStreaks(data: StreakData, home: string = homedir()): void {
  try {
    mkdirSync(join(home, ".ashlr"), { recursive: true });
    writeFileSync(streakPath(home), JSON.stringify(data, null, 2));
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/** UTC YYYY-MM-DD for the given timestamp (or now). */
export function todayKey(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Number of calendar days between two YYYY-MM-DD strings. */
export function daysBetween(a: string, b: string): number {
  const msA = Date.parse(a);
  const msB = Date.parse(b);
  if (!Number.isFinite(msA) || !Number.isFinite(msB)) return Infinity;
  return Math.round(Math.abs(msA - msB) / 86_400_000);
}

/**
 * Compute updated streak given existing data and today's key.
 *
 * Rules:
 *   - same day as lastActiveDay → no change (idempotent)
 *   - gap of 1 day (yesterday was the last active day) → streak extends
 *   - gap of 2+ days BUT ≤ grace (1 missed day) → still extends
 *   - gap > 1-day grace → reset to 1
 *
 * Grace rule: a SINGLE missed day (gap = 2: last active 2 days ago) is
 * forgiven. Gap of 3+ days breaks the streak.
 */
export function computeNewStreak(data: StreakData, today: string): StreakData {
  if (!today) return data;

  // No prior active day → start streak.
  if (!data.lastActiveDay) {
    return {
      currentStreak: 1,
      longestStreak: Math.max(1, data.longestStreak),
      lastActiveDay: today,
    };
  }

  const gap = daysBetween(data.lastActiveDay, today);

  // Same day — idempotent.
  if (gap === 0) return data;

  let newStreak: number;
  if (gap <= 2) {
    // 1-day gap = consecutive; 2-day gap = one missed day (grace).
    newStreak = data.currentStreak + 1;
  } else {
    // Streak broken.
    newStreak = 1;
  }

  return {
    currentStreak: newStreak,
    longestStreak: Math.max(newStreak, data.longestStreak),
    lastActiveDay: today,
  };
}

/**
 * Public API: bump the streak for today.
 * Gated by lastActiveDay so it's a no-op if already called today.
 * Never throws.
 */
export function bumpStreak(home: string = homedir(), nowMs: number = Date.now()): void {
  try {
    const data = readStreaks(home);
    const today = todayKey(nowMs);
    // If we already recorded today, skip the write entirely.
    if (data.lastActiveDay === today) return;
    const updated = computeNewStreak(data, today);
    writeStreaks(updated, home);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers (used by status-line, dashboard, savings)
// ---------------------------------------------------------------------------

/** Returns a streak label like "5d streak" or "" when streak < 3. */
export function renderStreakLabel(data: StreakData): string {
  if (data.currentStreak < 3) return "";
  return `${data.currentStreak}d streak`;
}

/**
 * Returns a streak badge for the status line: "* Nd streak" (ASCII star,
 * no emoji — matches the no-emoji convention of the rest of the status line).
 * Returns "" when streak < 3.
 */
export function renderStreakBadge(data: StreakData): string {
  if (data.currentStreak < 3) return "";
  return `* ${data.currentStreak}d streak`;
}
