import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const file = "site/public/benchmarks-v2.json";
const raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

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

describe(`${file} validity`, () => {
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
});
