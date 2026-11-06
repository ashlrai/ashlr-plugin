import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { GREP_PATTERNS, METHODOLOGY } from "../scripts/run-benchmark";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const TODO_PATTERN = "TODO";

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

describe("benchmark grep `TODO` pattern consistency", () => {
  test("the runner configures the TODO search string without a trailing space", () => {
    expect(GREP_PATTERNS).toContain(TODO_PATTERN);
    expect(GREP_PATTERNS.indexOf(TODO_PATTERN)).toBe(2);
    expect(GREP_PATTERNS).not.toContain("TODO ");
    expect(GREP_PATTERNS).not.toContain("todo");

    // TODO is the only configured pattern that does not end with a space —
    // the convention the docs call out for the fixed workload.
    const trailingSpace = GREP_PATTERNS.filter((pattern) => pattern.endsWith(" "));
    expect(trailingSpace).toHaveLength(4);
    expect(trailingSpace).not.toContain(TODO_PATTERN);
  });

  test("the documented grep methodology includes the configured TODO pattern", () => {
    const docs = read("docs/benchmarks.md");
    const documented = documentedGrepPatterns(docs);
    expect(documented).toContain(TODO_PATTERN);
    expect(documented.indexOf(TODO_PATTERN)).toBe(2);
    expect(documented).not.toContain("TODO ");
    expectDocumentedPatternsToMatch(docs);

    // The documented methodology explains the trailing-space exception that
    // applies to `TODO` — dropping it would misdocument the workload.
    expect(docs).toContain("The four strings other than `TODO` include a trailing space");

    // The Rust caveat names `TODO` among the low-match patterns and explains
    // that it can match Rust comments; removing either would misdocument the
    // workload's Rust limitation.
    const caveat = docs.match(/\*\*Note on grep for Rust:\*\*[\s\S]*?(?=\n\s*\n|$)/);
    expect(caveat).not.toBeNull();
    expect(caveat![0]).toContain("`TODO`");
    expect(caveat![0]).toContain("`TODO` can match Rust comments");
  });

  test("the runner methodology names the same TODO pattern the config runs", () => {
    expectMethodologyToDocumentPatterns(METHODOLOGY);
    expect(methodologyGrepPatterns(METHODOLOGY)).toContain("TODO");
    expect(methodologyGrepPatterns(METHODOLOGY)).not.toContain("TODO ");

    // The same methodology string is embedded in the saved snapshot.
    const saved = JSON.parse(read("docs/benchmarks-v2.json"));
    expect(methodologyGrepPatterns(saved.methodology)).toEqual(
      methodologyGrepPatterns(METHODOLOGY),
    );
  });

  test("the saved benchmark samples include a measurement for the TODO pattern", () => {
    const data = JSON.parse(read("docs/benchmarks-v2.json"));
    const sampled = data.samples.ashlr__grep.map((sample: { pattern: string }) => sample.pattern);
    expect(sampled).toContain(TODO_PATTERN);
    expect(sampled).not.toContain("TODO ");
    expect(sampled).toEqual([...GREP_PATTERNS]);
  });

  test("dropping or rewriting the documented TODO pattern breaks parity", () => {
    const docs = read("docs/benchmarks.md");
    for (const replacement of ['"TODO "', '"todo"', '"FIXME"']) {
      const changed = docs.replace('"TODO"', replacement);
      expect(changed).not.toBe(docs);
      expect(() => expectDocumentedPatternsToMatch(changed)).toThrow();
    }

    const missing = docs.replace('"TODO", ', "");
    const duplicated = docs.replace('"TODO", ', '"TODO", "TODO", ');
    expect(missing).not.toBe(docs);
    expect(duplicated).not.toBe(docs);
    expect(() => expectDocumentedPatternsToMatch(missing)).toThrow();
    expect(() => expectDocumentedPatternsToMatch(duplicated)).toThrow();
  });

  test("a methodology missing or renaming TODO fails the consistency check", () => {
    for (const mutated of [
      METHODOLOGY.replace("import, TODO, class", "import, class"),
      METHODOLOGY.replace("import, TODO, class", "import, todo, class"),
    ]) {
      expect(mutated).not.toBe(METHODOLOGY);
      expect(() => expectMethodologyToDocumentPatterns(mutated)).toThrow();
    }
  });
});
