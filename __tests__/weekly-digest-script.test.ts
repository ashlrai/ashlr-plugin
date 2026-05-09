/**
 * Unit tests for scripts/weekly-digest.ts
 *
 * Coverage:
 *   - Full digest renders for Pro users
 *   - Teaser renders for free-tier users
 *   - Digest skips if < 7 days since last shown
 *   - Digest fires after 7+ days
 *   - getDigestForResume skips if recent, fires if stale
 *   - shouldShowDigestInResume logic
 *   - computeWeekTokens sums only prior-week days
 *   - renderTopToolsSection renders top 5 with %
 *   - renderStreakSection skips when streak < 1
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildWeeklyDigest,
  computeWeekTokens,
  getDigestForResume,
  isProUser,
  readDigestResumeState,
  renderProTeaser,
  renderStreakSection,
  renderTopToolsSection,
  shouldShowDigestInResume,
  writeDigestResumeState,
} from "../scripts/weekly-digest";

import { writeStreaks } from "../servers/_streaks";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-wdigest-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeStats(data: object): Promise<void> {
  await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(data));
}

async function writeProToken(): Promise<void> {
  await writeFile(join(home, ".ashlr", "pro-token"), "tok_test_fake");
}

// ---------------------------------------------------------------------------
// isProUser
// ---------------------------------------------------------------------------

describe("isProUser", () => {
  test("no pro-token file → false", () => {
    expect(isProUser(home)).toBe(false);
  });

  test("pro-token file present → true", async () => {
    await writeProToken();
    expect(isProUser(home)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldShowDigestInResume / state IO
// ---------------------------------------------------------------------------

describe("shouldShowDigestInResume", () => {
  test("no prior state → true (never shown)", () => {
    expect(shouldShowDigestInResume(home)).toBe(true);
  });

  test("shown < 7 days ago → false", () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString();
    writeDigestResumeState({ last_digest_shown_ts: sixDaysAgo }, home);
    expect(shouldShowDigestInResume(home)).toBe(false);
  });

  test("shown exactly 7 days ago → true", () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    writeDigestResumeState({ last_digest_shown_ts: sevenDaysAgo }, home);
    expect(shouldShowDigestInResume(home)).toBe(true);
  });

  test("shown 8 days ago → true", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    writeDigestResumeState({ last_digest_shown_ts: eightDaysAgo }, home);
    expect(shouldShowDigestInResume(home)).toBe(true);
  });
});

describe("readDigestResumeState / writeDigestResumeState", () => {
  test("missing file → null last_digest_shown_ts", () => {
    const s = readDigestResumeState(home);
    expect(s.last_digest_shown_ts).toBeNull();
  });

  test("round-trip", () => {
    const ts = "2026-05-01T00:00:00.000Z";
    writeDigestResumeState({ last_digest_shown_ts: ts }, home);
    expect(readDigestResumeState(home).last_digest_shown_ts).toBe(ts);
  });
});

// ---------------------------------------------------------------------------
// computeWeekTokens
// ---------------------------------------------------------------------------

describe("computeWeekTokens", () => {
  test("sums only days in the specified week", () => {
    const byDay = {
      "2026-04-20": { tokensSaved: 100_000 }, // week 17
      "2026-04-21": { tokensSaved: 50_000 },  // week 17
      "2026-04-27": { tokensSaved: 999_999 }, // week 18 — excluded
    };
    const tokens = computeWeekTokens(byDay, "2026-17");
    expect(tokens).toBe(150_000);
  });

  test("empty byDay → 0", () => {
    expect(computeWeekTokens({}, "2026-17")).toBe(0);
  });

  test("undefined byDay → 0", () => {
    expect(computeWeekTokens(undefined, "2026-17")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// renderTopToolsSection
// ---------------------------------------------------------------------------

describe("renderTopToolsSection", () => {
  test("renders top tools with call count and lifetime share %", () => {
    const byTool = {
      "ashlr__grep": { tokensSaved: 8000, calls: 80 },
      "ashlr__read": { tokensSaved: 2000, calls: 20 },
    };
    const out = renderTopToolsSection(byTool);
    expect(out).toContain("Top tools (all time)");
    expect(out).toContain("ashlr__grep");
    expect(out).toContain("80 calls");
    expect(out).toContain("80%");
    expect(out).toContain("ashlr__read");
    expect(out).toContain("20%");
  });

  test("caps at 5 tools", () => {
    const byTool: Record<string, { tokensSaved: number; calls: number }> = {};
    for (let i = 0; i < 10; i++) {
      byTool[`tool_${i}`] = { tokensSaved: 1000 - i * 10, calls: 10 };
    }
    const out = renderTopToolsSection(byTool);
    const matches = out.match(/^- \*\*/gm) ?? [];
    expect(matches.length).toBeLessThanOrEqual(5);
  });

  test("returns empty string when byTool undefined or empty", () => {
    expect(renderTopToolsSection(undefined)).toBe("");
    expect(renderTopToolsSection({})).toBe("");
  });
});

// ---------------------------------------------------------------------------
// renderStreakSection
// ---------------------------------------------------------------------------

describe("renderStreakSection", () => {
  test("returns empty when no streak file", () => {
    expect(renderStreakSection(home)).toBe("");
  });

  test("returns empty when streak < 1", () => {
    writeStreaks({ currentStreak: 0, longestStreak: 0, lastActiveDay: "" }, home);
    expect(renderStreakSection(home)).toBe("");
  });

  test("shows streak when >= 1", () => {
    writeStreaks({ currentStreak: 5, longestStreak: 10, lastActiveDay: "2026-05-08" }, home);
    const out = renderStreakSection(home);
    expect(out).toContain("5d");
    expect(out).toContain("10d");
  });
});

// ---------------------------------------------------------------------------
// renderProTeaser
// ---------------------------------------------------------------------------

describe("renderProTeaser", () => {
  test("contains Pro mention and /ashlr-tier", () => {
    const teaser = renderProTeaser();
    expect(teaser).toContain("Pro");
    expect(teaser).toContain("/ashlr-tier");
  });
});

// ---------------------------------------------------------------------------
// buildWeeklyDigest — integration
// ---------------------------------------------------------------------------

describe("buildWeeklyDigest", () => {
  test("free user → teaser (not full digest)", () => {
    const result = buildWeeklyDigest({ home, force: true, suppressStateWrite: true });
    expect(result.fired).toBe(true);
    expect(result.isPro).toBe(false);
    expect(result.markdown).toContain("Pro");
    expect(result.markdown).toContain("/ashlr-tier");
    // Should NOT contain the full weekly digest header
    expect(result.markdown).not.toContain("## ashlr Weekly Digest");
  });

  test("Pro user → full digest", async () => {
    await writeProToken();
    await writeStats({
      schemaVersion: 2,
      sessions: {},
      lifetime: {
        tokensSaved: 50_000,
        calls: 100,
        byTool: { "ashlr__grep": { tokensSaved: 30_000, calls: 60 } },
        byDay: { "2026-04-20": { tokensSaved: 50_000, calls: 100 } },
      },
    });
    const result = buildWeeklyDigest({
      home,
      force: true,
      suppressStateWrite: true,
      isPro: true, // explicit override to avoid file system timing issues in tests
    });
    expect(result.fired).toBe(true);
    expect(result.isPro).toBe(true);
    expect(result.markdown).toContain("## ashlr Weekly Digest");
  });

  test("skips when < 7 days since last shown", () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString();
    writeDigestResumeState({ last_digest_shown_ts: sixDaysAgo }, home);
    const result = buildWeeklyDigest({ home }); // no force
    expect(result.fired).toBe(false);
    expect(result.markdown).toBeNull();
  });

  test("fires after 7+ days", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    writeDigestResumeState({ last_digest_shown_ts: eightDaysAgo }, home);
    const result = buildWeeklyDigest({ home, suppressStateWrite: true });
    expect(result.fired).toBe(true);
    expect(result.markdown).not.toBeNull();
  });

  test("updates last_digest_shown_ts when suppressStateWrite=false", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    writeDigestResumeState({ last_digest_shown_ts: eightDaysAgo }, home);
    buildWeeklyDigest({ home }); // fires + writes
    const state = readDigestResumeState(home);
    expect(state.last_digest_shown_ts).not.toBe(eightDaysAgo);
    // Should now be within the last minute
    const age = Date.now() - Date.parse(state.last_digest_shown_ts!);
    expect(age).toBeLessThan(60_000);
  });
});

// ---------------------------------------------------------------------------
// getDigestForResume
// ---------------------------------------------------------------------------

describe("getDigestForResume", () => {
  test("returns null when digest shown < 7 days ago", () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString();
    writeDigestResumeState({ last_digest_shown_ts: sixDaysAgo }, home);
    expect(getDigestForResume(home)).toBeNull();
  });

  test("returns non-null after 7+ days", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    writeDigestResumeState({ last_digest_shown_ts: eightDaysAgo }, home);
    const digest = getDigestForResume(home);
    expect(digest).not.toBeNull();
  });
});
