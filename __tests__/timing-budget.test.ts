import { describe, expect, test } from "bun:test";
import { timingBudgetMs, timingMultiplier, windowsCiTimingBudgetMs } from "../scripts/timing-budget.ts";

describe("timing-budget", () => {
  test("local runs keep the original budget", () => {
    expect(timingMultiplier({}, "darwin")).toBe(1);
    expect(timingBudgetMs(300, {}, "linux")).toBe(300);
    expect(timingBudgetMs(300, { CI: "false" }, "darwin")).toBe(300);
    expect(timingBudgetMs(300, { CI: "0" }, "darwin")).toBe(300);
  });

  test("CI scales macOS 3x and other platforms 2x", () => {
    expect(timingBudgetMs(300, { CI: "true" }, "darwin")).toBe(900);
    expect(timingBudgetMs(300, { CI: "true" }, "linux")).toBe(600);
  });

  test("ASHLR_TIMING_MULTIPLIER overrides, but never tightens below 1x", () => {
    expect(timingBudgetMs(300, { ASHLR_TIMING_MULTIPLIER: "5" }, "linux")).toBe(1500);
    expect(timingBudgetMs(300, { CI: "true", ASHLR_TIMING_MULTIPLIER: "1.5" }, "darwin")).toBe(450);
    expect(timingBudgetMs(300, { ASHLR_TIMING_MULTIPLIER: "0.1" }, "linux")).toBe(300);
    expect(timingBudgetMs(300, { ASHLR_TIMING_MULTIPLIER: "abc", CI: "1" }, "linux")).toBe(600);
  });
});


describe("Windows CI ledger lifecycle budget", () => {
  test("only Windows CI uses the established 38/40s bounded lifecycle", () => {
    for (const CI of ["1", "true", "TRUE", "github"]) {
      expect(windowsCiTimingBudgetMs(19_000, { CI }, "win32")).toBe(38_000);
      expect(windowsCiTimingBudgetMs(20_000, { CI }, "win32")).toBe(40_000);
    }
    for (const CI of [undefined, "", "0", "false", "FALSE"]) {
      expect(windowsCiTimingBudgetMs(19_000, { CI }, "win32")).toBe(19_000);
      expect(windowsCiTimingBudgetMs(20_000, { CI }, "win32")).toBe(20_000);
    }
  });
  test("all other platforms retain their original budgets on CI and locally", () => {
    for (const platform of ["darwin", "linux"] as const) for (const CI of [undefined, "1", "true"]) {
      expect(windowsCiTimingBudgetMs(19_000, { CI }, platform)).toBe(19_000);
      expect(windowsCiTimingBudgetMs(20_000, { CI }, platform)).toBe(20_000);
    }
  });
  test("an arbitrary existing multiplier cannot weaken this closed lifecycle budget", () => {
    for (const ASHLR_TIMING_MULTIPLIER of ["1", "5", "999", "Infinity"]) {
      for (const CI of [undefined, "1"]) for (const platform of ["win32", "darwin", "linux"] as const) {
        const env = { CI, ASHLR_TIMING_MULTIPLIER };
        const expected = platform === "win32" && CI ? 2 : 1;
        const inner = windowsCiTimingBudgetMs(19_000, env, platform);
        const outer = windowsCiTimingBudgetMs(20_000, env, platform);
        expect(inner).toBe(19_000 * expected);
        expect(outer).toBe(20_000 * expected);
        expect(inner).toBeLessThan(outer);
      }
    }
  });
});
