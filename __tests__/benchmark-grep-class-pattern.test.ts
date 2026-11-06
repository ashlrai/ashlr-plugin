import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { GREP_PATTERNS, METHODOLOGY } from "../scripts/run-benchmark";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const CLASS_PATTERN = "class ";

function documentedGrepPatterns(docs: string): string[] {
  const list = docs.match(/\*\*Grep patterns:\*\*[\s\S]*?```json\s*\n([^\n]+)\n```/);
  expect(list).not.toBeNull();
  return JSON.parse(list![1]!);
}

function expectDocumentedPatternsToMatch(docs: string): void {
  expect(documentedGrepPatterns(docs)).toEqual([...GREP_PATTERNS]);
}

function methodologyGrepPatterns(methodology: string): string[] {
  const list = methodology.match(/\*\*ashlr__grep\*\*:\s*[^\n]*?patterns\s*\(([^)]*)\)/);
  expect(list).not.toBeNull();
  return list![1]!.split(",").map((name) => name.trim());
}

function expectMethodologyToDocumentPatterns(methodology: string): void {
  expect(methodologyGrepPatterns(methodology)).toEqual(
    GREP_PATTERNS.map((pattern) => pattern.trim()),
  );
}

describe("benchmark grep `class` pattern consistency", () => {
  test("the runner configures the class search string with its trailing space", () => {
    expect(GREP_PATTERNS).toContain(CLASS_PATTERN);
    expect(GREP_PATTERNS).not.toContain("class");
    expect(GREP_PATTERNS.indexOf(CLASS_PATTERN)).toBe(3);
  });

  test("the documented grep methodology includes the configured class pattern", () => {
    const docs = read("docs/benchmarks.md");
    const documented = documentedGrepPatterns(docs);
    expect(documented).toContain(CLASS_PATTERN);
    expect(documented.indexOf(CLASS_PATTERN)).toBe(3);
    expect(documented).not.toContain("class");
    expectDocumentedPatternsToMatch(docs);

    // The documented methodology explains the trailing-space convention that
    // applies to `class ` — dropping it would misdocument the workload.
    expect(docs).toContain("The four strings other than `TODO` include a trailing space");

    // The Rust caveat names `class` among the low-match patterns; removing it
    // there would misdocument the workload's Rust limitation.
    const caveat = docs.match(/\*\*Note on grep for Rust:\*\*[\s\S]*?(?=\n\s*\n|$)/);
    expect(caveat).not.toBeNull();
    expect(caveat![0]).toContain("`class`");
  });

  test("the runner methodology names the same class pattern the config runs", () => {
    expectMethodologyToDocumentPatterns(METHODOLOGY);
    expect(methodologyGrepPatterns(METHODOLOGY)).toContain("class");

    // The same methodology string is embedded in the saved snapshot.
    const saved = JSON.parse(read("docs/benchmarks-v2.json"));
    expect(methodologyGrepPatterns(saved.methodology)).toEqual(
      methodologyGrepPatterns(METHODOLOGY),
    );
  });

  test("the saved benchmark samples include a measurement for the class pattern", () => {
    const data = JSON.parse(read("docs/benchmarks-v2.json"));
    const sampled = data.samples.ashlr__grep.map((sample: { pattern: string }) => sample.pattern);
    expect(sampled).toContain(CLASS_PATTERN);
    expect(sampled).toEqual([...GREP_PATTERNS]);
  });

  test("dropping or rewriting the documented class pattern breaks parity", () => {
    const docs = read("docs/benchmarks.md");
    for (const replacement of ['"class"', '"struct "', '"record "']) {
      const changed = docs.replace('"class "', replacement);
      expect(changed).not.toBe(docs);
      expect(() => expectDocumentedPatternsToMatch(changed)).toThrow();
    }

    const missing = docs.replace('"class ", ', "");
    const duplicated = docs.replace('"class ", ', '"class ", "class ", ');
    expect(missing).not.toBe(docs);
    expect(duplicated).not.toBe(docs);
    expect(() => expectDocumentedPatternsToMatch(missing)).toThrow();
    expect(() => expectDocumentedPatternsToMatch(duplicated)).toThrow();
  });

  test("a methodology missing or renaming class fails the consistency check", () => {
    for (const mutated of [
      METHODOLOGY.replace("TODO, class", "TODO"),
      METHODOLOGY.replace("TODO, class, interface", "TODO, classes, interface"),
    ]) {
      expect(mutated).not.toBe(METHODOLOGY);
      expect(() => expectMethodologyToDocumentPatterns(mutated)).toThrow();
    }
  });
});
