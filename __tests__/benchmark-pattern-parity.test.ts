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
});
