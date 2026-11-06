import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { GREP_PATTERNS } from "../scripts/run-benchmark";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const FUNCTION_PATTERN = "function ";

function documentedGrepPatterns(docs: string): string[] {
  const section = docs.match(/\*\*Grep patterns:\*\*[\s\S]*?```json\s*\n([\s\S]*?)\n```/);
  expect(section).not.toBeNull();
  return JSON.parse(section![1]!);
}

function expectDocumentedPatternsToMatch(docs: string): void {
  expect(documentedGrepPatterns(docs)).toEqual([...GREP_PATTERNS]);
}

function runnerMethodologyPatterns(source: string): string[] {
  const list = source.match(/\*\*ashlr__grep\*\*:\s*[^\n]*?patterns\s*\(([^)]*)\)/);
  expect(list).not.toBeNull();
  return list![1]!.split(",").map((name) => name.trim());
}

describe("benchmark grep function pattern", () => {
  test("the runner configures `function ` as the first pattern, with a trailing space", () => {
    expect(GREP_PATTERNS[0]).toBe(FUNCTION_PATTERN);
    expect(GREP_PATTERNS).toContain(FUNCTION_PATTERN);
    expect(GREP_PATTERNS).not.toContain("function");
  });

  test("the documented grep methodology includes the configured function pattern", () => {
    const docs = read("docs/benchmarks.md");
    const documented = documentedGrepPatterns(docs);

    expect(documented).toContain(FUNCTION_PATTERN);
    expect(documented[0]).toBe(FUNCTION_PATTERN);
    expect(documented).not.toContain("function");
    expect(documented).toEqual([...GREP_PATTERNS]);

    // The documented methodology explains the trailing-space convention that
    // applies to `function ` — dropping it would misdocument the workload.
    expect(docs).toContain("the runner uses these same five search strings for every\nrepo");
    expect(docs).toContain("The four strings other than `TODO` include a trailing space");
  });

  test("the runner's recorded methodology names function among the grep patterns", () => {
    const source = read("scripts/run-benchmark.ts");
    const names = runnerMethodologyPatterns(source);
    expect(names).toEqual(GREP_PATTERNS.map((pattern) => pattern.trim()));
    expect(names[0]).toBe("function");

    // The same methodology string is embedded in the saved snapshot.
    const saved = JSON.parse(read("docs/benchmarks-v2.json"));
    expect(runnerMethodologyPatterns(saved.methodology)).toEqual(names);
  });

  test("the saved benchmark samples include a measurement for the function pattern", () => {
    const data = JSON.parse(read("docs/benchmarks-v2.json"));
    const sampled = data.samples.ashlr__grep.map((sample: { pattern: string }) => sample.pattern);
    expect(sampled).toContain(FUNCTION_PATTERN);
    expect(sampled).toEqual([...GREP_PATTERNS]);
  });

  test("the check fails when the documented function pattern is removed or altered", () => {
    const docs = read("docs/benchmarks.md");
    for (const replacement of ['"function"', '"fn "', '"method "']) {
      const changed = docs.replace('"function "', replacement);
      expect(changed).not.toBe(docs);
      expect(() => expectDocumentedPatternsToMatch(changed)).toThrow();
    }
  });

  test("the check fails when the documented function pattern is missing or duplicated", () => {
    const docs = read("docs/benchmarks.md");
    const missing = docs.replace('"function ", ', "");
    const duplicated = docs.replace('"function ", ', '"function ", "function ", ');
    expect(missing).not.toBe(docs);
    expect(duplicated).not.toBe(docs);
    expect(() => expectDocumentedPatternsToMatch(missing)).toThrow();
    expect(() => expectDocumentedPatternsToMatch(duplicated)).toThrow();
  });
});
