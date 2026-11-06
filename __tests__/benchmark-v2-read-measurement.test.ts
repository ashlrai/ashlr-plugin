import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const data = JSON.parse(read("docs/benchmarks-v2.json"));
const guide = read("docs/benchmark-v2-read-measurement.md");

describe("v2 read measurement guide", () => {
  test("links the saved source and explains its fields and units", () => {
    expect(guide).toContain("[\`docs/benchmarks-v2.json\`](benchmarks-v2.json)");
    expect(read("docs/README.md")).toContain("(benchmark-v2-read-measurement.md)");
    for (const field of ["rawBytes", "ashlrBytes", "rawTokens", "ashlrTokens", "ratio"]) {
      expect(data.samples.ashlr__read.every((sample: Record<string, unknown>) => typeof sample[field] === "number")).toBe(true);
      expect(guide).toContain(`\`${field}\``);
    }
    expect(guide).toContain("characters/4 heuristic");
    expect(guide).toContain("`ashlrTokens / rawTokens`");
    for (const sample of data.samples.ashlr__read) {
      expect(sample.ratio).toBeCloseTo(sample.ashlrTokens / sample.rawTokens, 12);
    }
  });

  test("describes the saved methodology and flags its sample-count discrepancy", () => {
    for (const phrase of ["snipCompact", "tool_result", "2 000 chars", "32-bit seed", "2–5 KB", "50+ KB"]) {
      expect(data.methodology).toContain(phrase);
    }
    expect(guide).toContain("2,000 characters");
    expect(guide).toContain(`contains ${data.samples.ashlr__read.length} entries`);
    expect(data.methodology).toContain("read\nhas 15");
    expect(guide).toContain("read has 15 samples");
    expect(guide).toContain("not a read-only result");
    expect(data.caveat).toContain("different commits are not like-for-like");
    expect(guide).toContain("not like-for-like");
  });
});
