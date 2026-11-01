import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { GREP_PATTERNS } from "../scripts/run-benchmark";

const expectedPatterns = ["function ", "import ", "TODO", "class ", "interface "] as const;

describe("benchmark grep workload", () => {
  test("configures the five distinct search strings", () => {
    expect(GREP_PATTERNS).toHaveLength(5);
    expect(new Set(GREP_PATTERNS).size).toBe(5);
    expect([...GREP_PATTERNS]).toEqual([...expectedPatterns]);
  });

  test.each([
    ["../docs/benchmarks.md", /\*\*Grep patterns:\*\*[\s\S]*?```json\s*\n([\s\S]*?)\n```/],
    ["../docs/benchmark-methodology-guide.md", /## Fixed grep workload and Rust[\s\S]*?```json\s*\n([\s\S]*?)\n```/],
    ["../docs/benchmark-rust-patterns.md", /## The fixed workload[\s\S]*?```json\s*\n([\s\S]*?)\n```/],
    ["../docs/benchmark-rust-pattern-caveat.md", /```json\s*\n([\s\S]*?)\n```/],
    ["../docs/grep-rust-benchmark-caveat.md", /```json\s*\n([\s\S]*?)\n```/],
    ["../docs/benchmark-pattern-selection.md", /## Recorded workload[\s\S]*?```json\s*\n([\s\S]*?)\n```/],
    ["../docs/benchmark-grep-pattern-list.md", /```json\s*\n([\s\S]*?)\n```/],
  ])("%s documents the configured patterns in order", (path, section) => {
    const docs = readFileSync(new URL(path, import.meta.url), "utf8");
    const list = docs.match(section);
    expect(list).not.toBeNull();
    expect(JSON.parse(list![1]!)).toEqual([...GREP_PATTERNS]);
  });

  test("pattern list identifies the benchmark tool and runner", () => {
    const docs = readFileSync(new URL("../docs/benchmark-grep-pattern-list.md", import.meta.url), "utf8");
    expect(docs).toContain("`ashlr__grep`");
    expect(docs).toContain("(../scripts/run-benchmark.ts)");
  });
});
