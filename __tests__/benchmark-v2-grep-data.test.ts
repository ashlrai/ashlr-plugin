import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const file = "docs/benchmarks-v2.json";

interface GrepSample {
  pattern: string;
  rawBytes: number;
  rawTokens: number;
  ashlrBytes: number;
  ashlrTokens: number;
  ratio: number;
  method: string;
}

const data = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as {
  methodology: string;
  samples: { ashlr__grep: GrepSample[] };
  aggregate: {
    ashlr__grep: {
      mean: number;
      p50: number;
      p90: number;
      confidenceInterval: { lo: number; hi: number };
    };
  };
};

const grep = data.samples.ashlr__grep;

describe(`${file} grep benchmark data`, () => {
  test("grep benchmark includes a TODO pattern", () => {
    expect(Array.isArray(grep)).toBe(true);
    const todo = grep.filter((sample) => sample.pattern === "TODO");
    expect(todo).toHaveLength(1);
  });

  test("the TODO sample is a consistent rg-truncated measurement", () => {
    const sample = grep.find((entry) => entry.pattern === "TODO");
    expect(sample).toBeDefined();
    expect(sample!.method).toBe("rg-truncated");
    for (const field of ["rawBytes", "rawTokens", "ashlrBytes", "ashlrTokens"] as const) {
      expect(Number.isFinite(sample![field]), field).toBe(true);
      expect(sample![field], field).toBeGreaterThan(0);
    }
    // The fallback caps line width and truncates, so output can only shrink.
    expect(sample!.ashlrBytes).toBeLessThanOrEqual(sample!.rawBytes);
    expect(sample!.ashlrTokens).toBeLessThanOrEqual(sample!.rawTokens);
    expect(sample!.ratio).toBeCloseTo(sample!.ashlrTokens / sample!.rawTokens, 12);
    expect(sample!.ratio).toBeGreaterThan(0);
    expect(sample!.ratio).toBeLessThanOrEqual(1);
  });

  test("each grep pattern is recorded once with a nonempty pattern string", () => {
    const patterns = grep.map((sample) => sample.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
    for (const pattern of patterns) {
      expect(typeof pattern).toBe("string");
      expect(pattern.trim().length).toBeGreaterThan(0);
    }
  });

  test("aggregate.ashlr__grep is computed from the recorded sample ratios", () => {
    const ratios = grep.map((sample) => sample.ratio).sort((a, b) => a - b);
    const agg = data.aggregate.ashlr__grep;
    expect(agg.mean).toBeCloseTo(ratios.reduce((sum, r) => sum + r, 0) / ratios.length, 12);
    expect(agg.p50).toBe(ratios[Math.floor(ratios.length * 0.5)]);
    expect(agg.p90).toBe(ratios[Math.floor(ratios.length * 0.9)]);
    expect(agg.confidenceInterval.lo).toBeGreaterThanOrEqual(ratios[0]!);
    expect(agg.confidenceInterval.hi).toBeLessThanOrEqual(ratios[ratios.length - 1]!);
    expect(agg.confidenceInterval.lo).toBeLessThanOrEqual(agg.confidenceInterval.hi);
  });

  test("methodology documents TODO in the fixed grep workload", () => {
    expect(data.methodology).toContain("function, import, TODO, class, interface");
  });
});
