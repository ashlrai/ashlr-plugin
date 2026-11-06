import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Per-entry check on the copy the site serves at /benchmarks-v2.json:
// every sample has the measurement fields its schema requires as finite
// numbers, and every grep sample has a nonempty pattern.
const data = JSON.parse(
  readFileSync(new URL("../site/public/benchmarks-v2.json", import.meta.url), "utf8"),
) as { samples: Record<string, Record<string, unknown>[]> };

const REQUIRED_NUMERIC: Record<string, string[]> = {
  ashlr__read: ["rawBytes", "rawTokens", "ashlrBytes", "ashlrTokens", "ratio"],
  ashlr__grep: ["rawBytes", "rawTokens", "ashlrBytes", "ashlrTokens", "ratio"],
  ashlr__edit: ["searchChars", "replaceChars", "naiveBytes", "naiveTokens", "ashlrBytes", "ashlrTokens", "ratio"],
};

describe("site/public/benchmarks-v2.json entries", () => {
  for (const [tool, fields] of Object.entries(REQUIRED_NUMERIC)) {
    test(`${tool}: samples exist and every measurement is a finite number`, () => {
      const samples = data.samples[tool];
      expect(Array.isArray(samples)).toBe(true);
      expect(samples!.length).toBeGreaterThan(0);
      samples!.forEach((sample, i) => {
        for (const field of fields) {
          expect(Number.isFinite(sample[field]), `${tool}[${i}].${field}`).toBe(true);
        }
      });
    });
  }

  test("every ashlr__grep entry has a nonempty string pattern", () => {
    data.samples.ashlr__grep!.forEach((sample, i) => {
      expect(typeof sample.pattern, `grep[${i}].pattern`).toBe("string");
      expect((sample.pattern as string).trim().length, `grep[${i}].pattern`).toBeGreaterThan(0);
    });
  });
});
