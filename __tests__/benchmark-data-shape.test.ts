import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const files = ["docs/benchmarks-v2.json", "site/public/benchmarks-v2.json"];
const tools = ["ashlr__read", "ashlr__grep", "ashlr__edit"] as const;

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as ObjectValue;
}

function strings(value: ObjectValue, keys: string[]): void {
  for (const key of keys) {
    expect(typeof value[key]).toBe("string");
    expect((value[key] as string).trim().length).toBeGreaterThan(0);
  }
}

function numbers(value: ObjectValue, keys: string[]): void {
  for (const key of keys) {
    expect(typeof value[key]).toBe("number");
    expect(Number.isFinite(value[key])).toBe(true);
    expect(value[key] as number).toBeGreaterThanOrEqual(0);
  }
}

describe.each(files)("benchmark data: %s", (file) => {
  test("contains the fields used by benchmark consumers", () => {
    const data = object(JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")));
    expect(data.version).toBe(2);
    strings(data, ["measuredAt", "methodology"]);
    expect(Number.isNaN(Date.parse(data.measuredAt as string))).toBe(false);

    const repo = object(data.repo);
    strings(repo, ["url", "commit"]);
    numbers(repo, ["files", "loc"]);

    const samples = object(data.samples);
    const aggregate = object(data.aggregate);
    for (const tool of tools) {
      const entries = samples[tool];
      expect(Array.isArray(entries)).toBe(true);
      expect((entries as unknown[]).length).toBeGreaterThan(0);
      for (const entry of entries as unknown[]) {
        const sample = object(entry);
        const commonNumbers = ["ashlrBytes", "ashlrTokens", "ratio"];
        if (tool === "ashlr__read") {
          strings(sample, ["path", "bucket"]);
          numbers(sample, [...commonNumbers, "rawBytes", "rawTokens"]);
        } else if (tool === "ashlr__grep") {
          strings(sample, ["pattern", "method"]);
          numbers(sample, [...commonNumbers, "rawBytes", "rawTokens"]);
        } else {
          strings(sample, ["size"]);
          numbers(sample, [...commonNumbers, "searchChars", "replaceChars", "naiveBytes", "naiveTokens"]);
        }
      }
      numbers(object(aggregate[tool]), ["mean", "p50", "p90"]);
    }
    numbers(object(aggregate.overall), ["mean"]);
  });
});
