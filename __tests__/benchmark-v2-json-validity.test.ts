import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// docs/benchmarks-v2.json is canonical (written by scripts/run-benchmark.ts);
// site/public/benchmarks-v2.json is the copy the site serves. Both must parse
// and carry nonempty pattern fields wherever a pattern is present.
const files = ["docs/benchmarks-v2.json", "site/public/benchmarks-v2.json"];

type ObjectValue = Record<string, unknown>;

function* recordsWithPattern(value: unknown, path: string): Generator<{ path: string; record: ObjectValue }> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* recordsWithPattern(value[i], `${path}[${i}]`);
  } else if (value !== null && typeof value === "object") {
    const record = value as ObjectValue;
    if ("pattern" in record) yield { path, record };
    for (const key of Object.keys(record)) yield* recordsWithPattern(record[key], path ? `${path}.${key}` : key);
  }
}

describe.each(files)("%s validity", (file) => {
  const raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

  test("parses as a JSON object", () => {
    const data: unknown = JSON.parse(raw);
    expect(data).not.toBeNull();
    expect(typeof data).toBe("object");
    expect(Array.isArray(data)).toBe(false);
  });

  test("every benchmark record carrying a pattern field has a nonempty pattern", () => {
    const data: unknown = JSON.parse(raw);
    const found = [...recordsWithPattern(data, "")];
    expect(found.length).toBeGreaterThan(0);
    for (const { path, record } of found) {
      expect(typeof record.pattern).toBe("string");
      expect((record.pattern as string).trim().length, path).toBeGreaterThan(0);
    }
  });

  test("every grep sample declares a nonempty pattern", () => {
    const data = JSON.parse(raw) as { samples: { ashlr__grep: unknown } };
    const samples = data.samples.ashlr__grep;
    expect(Array.isArray(samples)).toBe(true);
    expect((samples as unknown[]).length).toBeGreaterThan(0);
    for (const sample of samples as { pattern?: unknown }[]) {
      expect(typeof sample.pattern).toBe("string");
      expect((sample.pattern as string).trim().length).toBeGreaterThan(0);
    }
  });

  // Numeric fields each sample kind must carry (mirrors scripts/benchmark-schema.ts).
  const numericFields: Record<string, string[]> = {
    ashlr__read: ["rawBytes", "rawTokens", "ashlrBytes", "ashlrTokens", "ratio"],
    ashlr__grep: ["rawBytes", "rawTokens", "ashlrBytes", "ashlrTokens", "ratio"],
    ashlr__edit: ["searchChars", "replaceChars", "naiveBytes", "naiveTokens", "ashlrBytes", "ashlrTokens", "ratio"],
  };

  test.each(Object.keys(numericFields))("every %s sample has finite non-negative numeric measurements", (tool) => {
    const data = JSON.parse(raw) as { samples: Record<string, ObjectValue[]> };
    const samples = data.samples[tool];
    expect(Array.isArray(samples)).toBe(true);
    expect(samples.length).toBeGreaterThan(0);
    samples.forEach((sample, i) => {
      for (const key of numericFields[tool]!) {
        const value = sample[key];
        const where = `${tool}[${i}].${key}`;
        expect(typeof value, where).toBe("number");
        expect(Number.isFinite(value as number), where).toBe(true);
        expect(value as number, where).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
