import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { GREP_PATTERNS, METHODOLOGY } from "../scripts/run-benchmark";

const IMPORT_PATTERN = "import ";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

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

describe("benchmark grep `import` pattern consistency", () => {
  test("the runner configures the import search string with its trailing space", () => {
    expect(GREP_PATTERNS).toContain(IMPORT_PATTERN);
    expect(GREP_PATTERNS).not.toContain("import");
    expect(GREP_PATTERNS.indexOf(IMPORT_PATTERN)).toBe(1);
  });

  test("the documented grep methodology includes the configured import pattern", () => {
    const docs = read("docs/benchmarks.md");
    const documented = documentedGrepPatterns(docs);
    expect(documented).toContain(IMPORT_PATTERN);
    expectDocumentedPatternsToMatch(docs);

    const section = docs.match(/\*\*Grep patterns:\*\*[\s\S]*?(?=\n\*\*Note on grep for Rust:\*\*)/);
    expect(section).not.toBeNull();
    expect(section![0]).toContain("trailing space");
    expect(docs).toContain("`import`");
  });

  test("the runner methodology names the same import pattern the config runs", () => {
    expectMethodologyToDocumentPatterns(METHODOLOGY);
    expect(methodologyGrepPatterns(METHODOLOGY)).toContain("import");

    const paragraph = METHODOLOGY.match(/\*\*ashlr__grep\*\*:[\s\S]*?(?=\n\n)/);
    expect(paragraph).not.toBeNull();
    expect(paragraph![0]).toContain("`rg -n`");
  });

  test("dropping or rewriting the documented import pattern breaks parity", () => {
    const docs = read("docs/benchmarks.md");
    for (const replacement of ['"import", ', ""]) {
      const changed = docs.replace('"import ", ', replacement);
      expect(changed).not.toBe(docs);
      expect(documentedGrepPatterns(changed)).not.toContain(IMPORT_PATTERN);
      expect(() => expectDocumentedPatternsToMatch(changed)).toThrow();
    }

    const renamed = docs.replace('"import "', '"requires "');
    expect(renamed).not.toBe(docs);
    expect(() => expectDocumentedPatternsToMatch(renamed)).toThrow();
  });

  test("a methodology missing import fails the consistency check", () => {
    for (const mutated of [
      METHODOLOGY.replace("function, import", "function"),
      METHODOLOGY.replace("function, import, TODO", "function, imports, TODO"),
    ]) {
      expect(mutated).not.toBe(METHODOLOGY);
      expect(() => expectMethodologyToDocumentPatterns(mutated)).toThrow();
    }
  });
});
