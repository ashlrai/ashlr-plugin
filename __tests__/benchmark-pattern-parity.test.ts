import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { GREP_PATTERNS } from "../scripts/run-benchmark";

function expectDocumentedPatternsToMatch(docs: string) {
  const section = docs.match(/\*\*Grep patterns:\*\*([^]*?)(?=\n\*\*Note on grep for Rust:\*\*)/);
  expect(section).not.toBeNull();
  const list = section![1]!.match(/```json\s*\n([^]*?)\n```/);
  expect(list).not.toBeNull();
  expect(JSON.parse(list![1]!)).toEqual([...GREP_PATTERNS]);
}

function expectRustLowMatchCaveat(docs: string) {
  const caveat = docs.match(/\*\*Note on grep for Rust:\*\*([^]*?)(?=\n\s*\n|$)/);
  expect(caveat).not.toBeNull();
  const statement = caveat![1]!.match(/[^.]*\blow match\s+rates\b[^.]*\./);
  expect(statement).not.toBeNull();
  for (const pattern of ["import", "TODO", "class", "interface"]) {
    expect(statement![0]).toContain(`\`${pattern}\``);
  }
}

describe("benchmark grep pattern documentation", () => {
  test("Rust interpretation lists the runner patterns exactly", () => {
    const guide = readFileSync(new URL("../docs/rust-grep-benchmark-interpretation.md", import.meta.url), "utf8");
    const docs = readFileSync(new URL("../docs/benchmarks.md", import.meta.url), "utf8");
    const list = guide.match(/```json\s*\n([^]*?)\n```/);
    expect(list).not.toBeNull();
    expect(JSON.parse(list![1]!)).toEqual([...GREP_PATTERNS]);
    expect(docs).toContain("(rust-grep-benchmark-interpretation.md)");
  });

  test("documents all five configured patterns exactly, including whitespace", () => {
    const docs = readFileSync(new URL("../docs/benchmarks.md", import.meta.url), "utf8");
    expect(GREP_PATTERNS).toHaveLength(5);
    expect(new Set(GREP_PATTERNS).size).toBe(5);
    expectDocumentedPatternsToMatch(docs);
  });

  test("Rust grep caveat identifies the low-match patterns", () => {
    const docs = readFileSync(new URL("../docs/benchmarks.md", import.meta.url), "utf8");
    expectRustLowMatchCaveat(docs);
  });

  test("rejects missing patterns or a missing low-match statement in the Rust caveat", () => {
    const docs = readFileSync(new URL("../docs/benchmarks.md", import.meta.url), "utf8");
    const statement = "The patterns `import`, `TODO`, `class`, and `interface` can have low match\nrates in Rust.";
    expect(docs).toContain(statement);
    for (const pattern of ["import", "TODO", "class", "interface"]) {
      expect(() => expectRustLowMatchCaveat(docs.replace(statement, statement.replace(`\`${pattern}\``, "omitted")))).toThrow();
    }
    expect(() => expectRustLowMatchCaveat(docs.replace(statement, statement.replace("low match\nrates", "high match rates")))).toThrow();
  });

  test("purpose guide lists each configured pattern with an explanation", () => {
    const guide = readFileSync(new URL("../docs/benchmark-pattern-purpose.md", import.meta.url), "utf8");
    const docs = readFileSync(new URL("../docs/benchmarks.md", import.meta.url), "utf8");
    const rows = [...guide.matchAll(/^\| `([^`]+)` \| ([^|]+) \|$/gm)];
    expect(rows.map((row) => row[1])).toEqual([...GREP_PATTERNS]);
    for (const row of rows) expect(row[2]!.trim().length).toBeGreaterThan(0);
    expect(docs).toContain("(benchmark-pattern-purpose.md)");
  });

  test("rejects a missing or extra documented pattern", () => {
    const docs = readFileSync(new URL("../docs/benchmarks.md", import.meta.url), "utf8");
    const missing = docs.replace('"TODO", ', "");
    const extra = docs.replace('"TODO", ', '"TODO", "extra pattern", ');
    expect(missing).not.toBe(docs);
    expect(extra).not.toBe(docs);
    expect(() => expectDocumentedPatternsToMatch(missing)).toThrow();
    expect(() => expectDocumentedPatternsToMatch(extra)).toThrow();
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

  test("language map covers the documented and public patterns with the Rust caveat", () => {
    const map = readFileSync(new URL("../docs/benchmark-pattern-language-map.md", import.meta.url), "utf8");
    const docs = readFileSync(new URL("../docs/benchmarks.md", import.meta.url), "utf8");
    const publicData = JSON.parse(readFileSync(new URL("../site/public/benchmarks-v2.json", import.meta.url), "utf8"));
    const documented = docs.match(/\*\*Grep patterns:\*\*[\s\S]*?```json\s*\n([\s\S]*?)\n```/);
    expect(documented).not.toBeNull();

    const rows = [...map.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)];
    const patterns = rows.map((row) => row[1]);
    expect(patterns).toEqual(JSON.parse(documented![1]!));
    expect(patterns).toEqual(publicData.samples.ashlr__grep.map((sample: { pattern: string }) => sample.pattern));
    const caveats = [/\bfn\b/, /\buse\b/, /comments/, /\bstruct\b.*\benum\b/, /\btrait\b/];
    rows.forEach((row, i) => expect(row[3]).toMatch(caveats[i]!));
    expect(map).toContain("(benchmarks.md#multi-repo-reference-set)");
    expect(map).toContain("(../site/public/benchmarks-v2.json)");
    expect(map).toContain(publicData.measuredAt.slice(0, 10));
    expect(map).toContain("not individual samples from the Rust reference repository");
    expect(map).toContain("No new measurements are reported");
  });
});
