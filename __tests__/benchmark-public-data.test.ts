import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const files = ["docs/benchmarks-v2.json", "site/public/benchmarks-v2.json"] as const;

function grepPatterns(file: string): string[] {
  const data = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
  const samples: unknown = data.samples.ashlr__grep;
  expect(Array.isArray(samples)).toBe(true);
  expect((samples as unknown[]).length).toBeGreaterThan(0);

  const patterns = (samples as { pattern?: unknown }[]).map((sample) => sample.pattern);
  for (const pattern of patterns) {
    expect(typeof pattern).toBe("string");
    expect((pattern as string).trim().length).toBeGreaterThan(0);
  }
  expect(new Set(patterns).size).toBe(patterns.length);
  return (patterns as string[]).sort();
}

describe("public benchmark data", () => {
  test("uses the same grep patterns as the documented benchmark", () => {
    expect(grepPatterns(files[1])).toEqual(grepPatterns(files[0]));
  });

  test.each([...files])("%s includes the exact TODO grep pattern", (file) => {
    expect(grepPatterns(file)).toContain("TODO");
  });
});
