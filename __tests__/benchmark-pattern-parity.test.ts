import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { GREP_PATTERNS } from "../scripts/run-benchmark";

describe("benchmark grep pattern documentation", () => {
  test("documents all five configured patterns exactly, including whitespace", () => {
    const docs = readFileSync(new URL("../docs/benchmarks.md", import.meta.url), "utf8");
    const section = docs.match(/\*\*Grep patterns:\*\*([^]*?)(?=\n\*\*Note on grep for Rust:\*\*)/);
    expect(section).not.toBeNull();
    const list = section![1]!.match(/```json\s*\n([^]*?)\n```/);
    expect(list).not.toBeNull();

    expect(GREP_PATTERNS).toHaveLength(5);
    expect(new Set(GREP_PATTERNS).size).toBe(5);
    expect(JSON.parse(list![1]!)).toEqual([...GREP_PATTERNS]);
  });

  test("pattern selection guide agrees with saved samples and Rust aggregates", () => {
    const guide = readFileSync(new URL("../docs/benchmark-pattern-selection.md", import.meta.url), "utf8");
    const data = JSON.parse(readFileSync(new URL("../docs/benchmarks-v2.json", import.meta.url), "utf8"));
    const list = guide.match(/```json\s*\n([^]*?)\n```/);
    expect(list).not.toBeNull();
    const recorded = data.samples.ashlr__grep.map((sample: { pattern: string }) => sample.pattern);
    expect(JSON.parse(list![1]!)).toEqual(recorded);
    expect(recorded).toEqual([...GREP_PATTERNS]);

    const rust = data.byRepo["rust-project"];
    expect(guide).toContain(data.crossLanguageMeasuredAt.slice(0, 10));
    expect(guide).toContain(rust.refrev.slice(0, 7));
    expect(guide).toContain(rust.perTool.grep.mean.toFixed(4));
    expect(guide).toContain(((1 - rust.perTool.grep.mean) * 100).toFixed(1) + "% savings");
    expect(guide).toContain(rust.meanRatio.toFixed(4));
    expect(guide).toContain(rust.savingsPct.toFixed(1) + "% savings");
  });
});
