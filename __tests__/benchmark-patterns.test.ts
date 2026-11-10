import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { GREP_PATTERNS } from "../scripts/run-benchmark";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The five-pattern workload documented across docs/benchmarks.md and the
// benchmark-grep-* docs. Order is significant: the saved benchmark output and
// the methodology string both record patterns in this sequence.
const DOCUMENTED_GREP_PATTERNS = ["function ", "import ", "TODO", "class ", "interface "] as const;

test("the benchmark grep workload includes TODO exactly once", () => {
  expect(GREP_PATTERNS.filter((pattern) => pattern === "TODO")).toHaveLength(1);
});

describe("benchmark grep pattern workload", () => {
  test("configures all five documented patterns in order", () => {
    expect(GREP_PATTERNS).toEqual([...DOCUMENTED_GREP_PATTERNS]);
    expect(GREP_PATTERNS).toHaveLength(DOCUMENTED_GREP_PATTERNS.length);
  });

  test("every configured pattern is distinct", () => {
    expect(new Set(GREP_PATTERNS).size).toBe(GREP_PATTERNS.length);
  });

  test("every configured pattern is a non-empty search string", () => {
    for (const pattern of GREP_PATTERNS) {
      expect(typeof pattern).toBe("string");
      expect(pattern.trim().length).toBeGreaterThan(0);
    }
  });

  test("the runner measures every configured pattern", () => {
    const source = read("scripts/run-benchmark.ts");
    // The grep measurement loop must iterate GREP_PATTERNS so each configured
    // pattern produces a sample; a hardcoded subset would silently drop work.
    expect(source).toContain("for (const pattern of GREP_PATTERNS)");
    expect(source).toContain("measureGrep(pattern, repo)");
  });

  test("the documented grep workload lists the same five patterns", () => {
    const docs = read("docs/benchmarks.md");
    const list = docs.match(/\*\*Grep patterns:\*\*[\s\S]*?```json\s*\n([^\n]+)\n```/);
    expect(list).not.toBeNull();
    expect(JSON.parse(list![1]!)).toEqual([...GREP_PATTERNS]);
  });
});
