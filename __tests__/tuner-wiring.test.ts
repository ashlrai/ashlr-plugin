import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { RG_TEXT_BUDGET, truncateRgText } from "../servers/_rg-text";
import { budgetScale, DETAIL_FACTOR, MAX_DETAIL, MIN_DETAIL, tunedDetail, tuningPath } from "../servers/_tuner";

// Synthetic ripgrep output well over the default budget.
const RAW = Array.from({ length: 400 }, (_, i) => `src/f${i % 7}.ts:${i + 1}:const value${i} = compute(${i});`).join("\n") + "\n";

afterEach(() => { delete process.env.ASHLR_TUNING; });

describe("tuner wiring: grep budgets", () => {
  test("level 0 is byte-identical to today's output", () => {
    expect(budgetScale(0)).toBe(1);
    expect(truncateRgText(RAW, null, budgetScale(0))).toBe(truncateRgText(RAW));
    expect(truncateRgText(RAW, "it timed out", budgetScale(0))).toBe(truncateRgText(RAW, "it timed out"));
  });

  test("+level keeps more detail, -level less", () => {
    const base = truncateRgText(RAW).length;
    expect(truncateRgText(RAW, null, budgetScale(1)).length).toBeGreaterThan(base);
    expect(truncateRgText(RAW, null, budgetScale(-1)).length).toBeLessThan(base);
  });

  test("scale is bounded by MIN/MAX_DETAIL", () => {
    expect(budgetScale(99)).toBe(DETAIL_FACTOR ** MAX_DETAIL);
    expect(budgetScale(-99)).toBe(DETAIL_FACTOR ** MIN_DETAIL);
    expect(Math.round(RG_TEXT_BUDGET * budgetScale(-99))).toBeGreaterThan(0);
  });

  test("off switch: stored +2 level reads as 0, so output is unchanged", () => {
    const home = mkdtempSync(join(tmpdir(), "ashlr-wiring-"));
    try {
      const p = tuningPath(home, "/repo");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ ashlr__grep: { "(none)": { level: 2, atSample: 40 } } }));
      expect(tunedDetail("ashlr__grep", "(none)", home, "/repo")).toBe(2);
      process.env.ASHLR_TUNING = "off";
      const lvl = tunedDetail("ashlr__grep", "(none)", home, "/repo");
      expect(lvl).toBe(0);
      expect(truncateRgText(RAW, null, budgetScale(lvl))).toBe(truncateRgText(RAW));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
