/**
 * Unit tests for _weekly-digest.ts
 *
 * Covers: digest fires once per week, suppressed at $0, opt-out works,
 * comparison scaling, ISO week helpers, and banner content.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildComparison,
  buildDigestBanner,
  computeBannerContent,
  isoWeekKey,
  isDigestDisabled,
  priorWeekKey,
  readDigestState,
  renderDigestBanner,
  weekDayKeys,
  writeDigestState,
  type DigestStats,
} from "../servers/_weekly-digest";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-digest-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ISO week helpers
// ---------------------------------------------------------------------------

describe("isoWeekKey", () => {
  test("known Monday → correct week", () => {
    // 2026-04-20 is a Monday, ISO week 17 of 2026.
    const d = new Date("2026-04-20T12:00:00Z");
    expect(isoWeekKey(d)).toBe("2026-17");
  });

  test("Sunday 2026-04-26 → same week as its Monday (Apr 20 = W17)", () => {
    const d = new Date("2026-04-26T12:00:00Z");
    expect(isoWeekKey(d)).toBe("2026-17");
  });

  test("different weeks produce different keys", () => {
    const w1 = isoWeekKey(new Date("2026-04-20T00:00:00Z"));
    const w2 = isoWeekKey(new Date("2026-04-27T00:00:00Z"));
    expect(w1).not.toBe(w2);
  });
});

describe("priorWeekKey", () => {
  test("returns the week before the given date", () => {
    const d = new Date("2026-04-27T12:00:00Z"); // week 18
    const prior = priorWeekKey(d);
    expect(prior).toBe(isoWeekKey(new Date("2026-04-20T12:00:00Z"))); // week 17
  });
});

describe("weekDayKeys", () => {
  test("returns 7 YYYY-MM-DD keys starting from Monday", () => {
    const keys = weekDayKeys("2026-17");
    expect(keys).toHaveLength(7);
    expect(keys[0]).toBe("2026-04-20"); // Monday of week 17
    expect(keys[6]).toBe("2026-04-26"); // Sunday
  });
});

// ---------------------------------------------------------------------------
// buildComparison — scaling logic
// ---------------------------------------------------------------------------

describe("buildComparison", () => {
  test("$0 → empty string", () => {
    expect(buildComparison(0)).toBe("");
  });

  test("negative → empty string", () => {
    expect(buildComparison(-5)).toBe("");
  });

  test("$37.20 → relatable quantity (not fractional/zero items)", () => {
    const result = buildComparison(37.20);
    // Should produce a whole-number quantity >= 2 of something recognizable.
    // Must NOT be "0 dinners" or partial quantities.
    expect(result).not.toMatch(/^0 /);
    expect(result).not.toMatch(/^1 dinner/i);
    // Quantity should be a whole number >= 2 for relatable comparison.
    const match = result.match(/^(\d+) /);
    expect(match).not.toBeNull();
    const qty = parseInt(match![1]!, 10);
    expect(qty).toBeGreaterThanOrEqual(2);
  });

  test("$50 → a relatable quantity (qty >= 2)", () => {
    const result = buildComparison(50);
    // Should produce something like "10 sandwiches" or "12 cups of coffee".
    const match = result.match(/^(\d+) /);
    expect(match).not.toBeNull();
    const qty = parseInt(match![1]!, 10);
    expect(qty).toBeGreaterThanOrEqual(2);
    // Must not be "1 dinner" — that's the unrelatable singleton.
    expect(result).not.toMatch(/^1 dinner/i);
  });

  test("$100 → a recognizable comparison (qty >= 1)", () => {
    const result = buildComparison(100);
    // Should produce something like "8 paperbacks" or "20 cups of coffee" or "1 side-gig hour".
    expect(result.length).toBeGreaterThan(0);
    const match = result.match(/^(\d+) /);
    expect(match).not.toBeNull();
  });

  test("$5 → produces a whole-number comparison", () => {
    const result = buildComparison(5);
    expect(result.length).toBeGreaterThan(0);
    // Must be a whole number quantity.
    expect(result).not.toMatch(/^\d+\.\d+ /);
    const match = result.match(/^(\d+) /);
    expect(match).not.toBeNull();
    expect(parseInt(match![1]!, 10)).toBeGreaterThanOrEqual(1);
  });

  test("$10 → produces a whole-number comparison", () => {
    const result = buildComparison(10);
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toMatch(/^\d+\.\d+ /);
    const match = result.match(/^(\d+) /);
    expect(match).not.toBeNull();
    expect(parseInt(match![1]!, 10)).toBeGreaterThanOrEqual(1);
  });

  test("quantity is floor division (no decimal quantities)", () => {
    const result = buildComparison(37.20);
    // No decimal in the quantity portion.
    expect(result).not.toMatch(/^\d+\.\d+ /);
    // Quantity must be a whole number >= 1.
    const match = result.match(/^(\d+) /);
    expect(match).not.toBeNull();
    const qty = parseInt(match![1]!, 10);
    expect(qty).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// isDigestDisabled
// ---------------------------------------------------------------------------

describe("isDigestDisabled", () => {
  test("no config, no env → not disabled", () => {
    // Temporarily clear the env var if set.
    const prior = process.env.ASHLR_DISABLE_DIGEST;
    delete process.env.ASHLR_DISABLE_DIGEST;
    try {
      expect(isDigestDisabled(home)).toBe(false);
    } finally {
      if (prior !== undefined) process.env.ASHLR_DISABLE_DIGEST = prior;
    }
  });

  test("ASHLR_DISABLE_DIGEST=1 → disabled", () => {
    const prior = process.env.ASHLR_DISABLE_DIGEST;
    process.env.ASHLR_DISABLE_DIGEST = "1";
    try {
      expect(isDigestDisabled(home)).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.ASHLR_DISABLE_DIGEST;
      else process.env.ASHLR_DISABLE_DIGEST = prior;
    }
  });

  test("config digest:off → disabled", async () => {
    await writeFile(
      join(home, ".ashlr", "config.json"),
      JSON.stringify({ digest: "off" }),
    );
    const prior = process.env.ASHLR_DISABLE_DIGEST;
    delete process.env.ASHLR_DISABLE_DIGEST;
    try {
      expect(isDigestDisabled(home)).toBe(true);
    } finally {
      if (prior !== undefined) process.env.ASHLR_DISABLE_DIGEST = prior;
    }
  });

  test("config digest:on → not disabled", async () => {
    await writeFile(
      join(home, ".ashlr", "config.json"),
      JSON.stringify({ digest: "on" }),
    );
    const prior = process.env.ASHLR_DISABLE_DIGEST;
    delete process.env.ASHLR_DISABLE_DIGEST;
    try {
      expect(isDigestDisabled(home)).toBe(false);
    } finally {
      if (prior !== undefined) process.env.ASHLR_DISABLE_DIGEST = prior;
    }
  });
});

// ---------------------------------------------------------------------------
// IO round-trip
// ---------------------------------------------------------------------------

describe("readDigestState / writeDigestState", () => {
  test("missing file → lastShownWeek empty string", () => {
    const d = readDigestState(home);
    expect(d.lastShownWeek).toBe("");
  });

  test("round-trip", () => {
    writeDigestState({ lastShownWeek: "2026-17" }, home);
    expect(readDigestState(home).lastShownWeek).toBe("2026-17");
  });
});

// ---------------------------------------------------------------------------
// computeBannerContent
// ---------------------------------------------------------------------------

describe("computeBannerContent", () => {
  test("sums tokens from prior week days only", () => {
    // Use a fixed "now" that's in week 18. Prior week = week 17 (Apr 20–26).
    const now = new Date("2026-04-27T12:00:00Z");
    const stats: DigestStats = {
      lifetime: {
        byDay: {
          "2026-04-20": { tokensSaved: 100_000, calls: 10 },
          "2026-04-21": { tokensSaved: 50_000,  calls: 5  },
          "2026-04-25": { tokensSaved: 200,      calls: 1  }, // still in week 17
          "2026-04-27": { tokensSaved: 999_999,  calls: 99 }, // this week — must be excluded
        },
        byTool: {
          ashlr__grep: { tokensSaved: 120_000, calls: 12 },
          ashlr__read: { tokensSaved: 30_200,  calls: 8  },
        },
      },
    };
    const content = computeBannerContent({ now, stats, dollarsSaved: 37.20, currentStreak: 5 });
    // 100000 + 50000 + 200 = 150200 (Apr 27 is excluded)
    expect(content.tokens).toBe(150_200);
    expect(content.dollars).toBe(37.20);
    expect(content.currentStreak).toBe(5);
    // Top tool by lifetime tokens saved = ashlr__grep (120k)
    expect(content.topTool).toBe("ashlr__grep");
  });
});

// ---------------------------------------------------------------------------
// renderDigestBanner
// ---------------------------------------------------------------------------

describe("renderDigestBanner", () => {
  test("basic render includes token count and dollar amount", () => {
    const content = {
      tokens: 12_400_000,
      dollars: 37.20,
      comparisonA: "9 cups of coffee",
      comparisonB: "7 sandwiches",
      currentStreak: 5,
      topTool: "ashlr__grep",
      topToolPct: 43,
    };
    const banner = renderDigestBanner(content);
    expect(banner).toContain("12.4M");
    expect(banner).toContain("~$37.20");
    expect(banner).toContain("9 cups of coffee");
    expect(banner).toContain("5d streak");
    expect(banner).toContain("ashlr__grep");
    expect(banner).toContain("43%");
  });

  test("no streak shown when currentStreak < 3", () => {
    const content = {
      tokens: 5_000_000,
      dollars: 15,
      comparisonA: "3 Spotify months",
      comparisonB: "",
      currentStreak: 2,
      topTool: "ashlr__read",
      topToolPct: 60,
    };
    const banner = renderDigestBanner(content);
    expect(banner).not.toContain("streak");
  });

  test("no comparison shown when comparisonA is empty", () => {
    const content = {
      tokens: 100,
      dollars: 0,
      comparisonA: "",
      comparisonB: "",
      currentStreak: 0,
      topTool: "",
      topToolPct: 0,
    };
    const banner = renderDigestBanner(content);
    expect(banner).not.toContain("That's like");
  });
});

// ---------------------------------------------------------------------------
// buildDigestBanner — integration (once-per-week gate)
// ---------------------------------------------------------------------------

describe("buildDigestBanner", () => {
  const now = new Date("2026-04-27T12:00:00Z"); // week 18

  // Stats with tokens in prior week (week 17).
  const statsWithData: DigestStats = {
    lifetime: {
      byDay: {
        "2026-04-20": { tokensSaved: 4_000_000, calls: 40 },
        "2026-04-21": { tokensSaved: 2_000_000, calls: 20 },
      },
      byTool: { ashlr__grep: { tokensSaved: 4_000_000, calls: 40 } },
    },
  };

  test("fires on first call for the week", () => {
    const prior = process.env.ASHLR_DISABLE_DIGEST;
    delete process.env.ASHLR_DISABLE_DIGEST;
    try {
      const result = buildDigestBanner({
        home,
        now,
        stats: statsWithData,
        dollarsSaved: 18,
        currentStreak: 4,
        suppressStateWrite: true,
      });
      expect(result.fired).toBe(true);
      expect(result.banner).not.toBeNull();
      expect(result.banner).toContain("Last week");
    } finally {
      if (prior !== undefined) process.env.ASHLR_DISABLE_DIGEST = prior;
    }
  });

  test("does NOT fire again in the same week", () => {
    const prior = process.env.ASHLR_DISABLE_DIGEST;
    delete process.env.ASHLR_DISABLE_DIGEST;
    try {
      // Mark this week as already shown.
      writeDigestState({ lastShownWeek: "2026-18" }, home);
      const result = buildDigestBanner({
        home,
        now,
        stats: statsWithData,
        dollarsSaved: 18,
        suppressStateWrite: true,
      });
      expect(result.fired).toBe(false);
      expect(result.banner).toBeNull();
    } finally {
      if (prior !== undefined) process.env.ASHLR_DISABLE_DIGEST = prior;
    }
  });

  test("suppressed when total tokens = 0", () => {
    const prior = process.env.ASHLR_DISABLE_DIGEST;
    delete process.env.ASHLR_DISABLE_DIGEST;
    try {
      const emptyStats: DigestStats = { lifetime: { byDay: {}, byTool: {} } };
      const result = buildDigestBanner({
        home,
        now,
        stats: emptyStats,
        dollarsSaved: 0,
        suppressStateWrite: true,
      });
      expect(result.fired).toBe(false);
      expect(result.banner).toBeNull();
    } finally {
      if (prior !== undefined) process.env.ASHLR_DISABLE_DIGEST = prior;
    }
  });

  test("opt-out via env var", () => {
    const prior = process.env.ASHLR_DISABLE_DIGEST;
    process.env.ASHLR_DISABLE_DIGEST = "1";
    try {
      const result = buildDigestBanner({
        home,
        now,
        stats: statsWithData,
        dollarsSaved: 18,
        suppressStateWrite: true,
      });
      expect(result.fired).toBe(false);
      expect(result.banner).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.ASHLR_DISABLE_DIGEST;
      else process.env.ASHLR_DISABLE_DIGEST = prior;
    }
  });

  test("opt-out via config.json", async () => {
    await writeFile(join(home, ".ashlr", "config.json"), JSON.stringify({ digest: "off" }));
    const prior = process.env.ASHLR_DISABLE_DIGEST;
    delete process.env.ASHLR_DISABLE_DIGEST;
    try {
      const result = buildDigestBanner({
        home,
        now,
        stats: statsWithData,
        dollarsSaved: 18,
        suppressStateWrite: true,
      });
      expect(result.fired).toBe(false);
    } finally {
      if (prior !== undefined) process.env.ASHLR_DISABLE_DIGEST = prior;
    }
  });

  test("marks week as shown in state (no suppressStateWrite)", () => {
    const prior = process.env.ASHLR_DISABLE_DIGEST;
    delete process.env.ASHLR_DISABLE_DIGEST;
    try {
      buildDigestBanner({ home, now, stats: statsWithData, dollarsSaved: 18 });
      const state = readDigestState(home);
      expect(state.lastShownWeek).toBe("2026-18");
    } finally {
      if (prior !== undefined) process.env.ASHLR_DISABLE_DIGEST = prior;
    }
  });

  test("comparison scales: $37 → relatable quantity, not partial/zero dinners", () => {
    const prior = process.env.ASHLR_DISABLE_DIGEST;
    delete process.env.ASHLR_DISABLE_DIGEST;
    try {
      const result = buildDigestBanner({
        home,
        now,
        stats: statsWithData,
        dollarsSaved: 37,
        suppressStateWrite: true,
      });
      // Must include a "That's like N ..." line with a whole-number quantity.
      expect(result.banner).toContain("That's like");
      expect(result.banner).not.toMatch(/0 dinner/i);
      // Quantity in the comparison must be >= 2 for this dollar amount.
      const match = result.banner!.match(/That's like (\d+) /);
      expect(match).not.toBeNull();
      const qty = parseInt(match![1]!, 10);
      expect(qty).toBeGreaterThanOrEqual(2);
    } finally {
      if (prior !== undefined) process.env.ASHLR_DISABLE_DIGEST = prior;
    }
  });
});
