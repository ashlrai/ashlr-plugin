import { describe, expect, test } from "bun:test";
import { timingBudgetMs, timingMultiplier } from "../scripts/timing-budget.ts";

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
