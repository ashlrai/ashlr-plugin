import { describe, expect, test } from "bun:test";

import { GREP_PATTERNS } from "../scripts/run-benchmark";

describe("benchmark grep patterns", () => {
  test("contains at least one pattern and no empty or whitespace-only patterns", () => {
    expect(GREP_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of GREP_PATTERNS) {
      expect(pattern.trim().length).toBeGreaterThan(0);
    }
  });

  test("contains no duplicate patterns", () => {
    expect(new Set(GREP_PATTERNS).size).toBe(GREP_PATTERNS.length);
  });
});
