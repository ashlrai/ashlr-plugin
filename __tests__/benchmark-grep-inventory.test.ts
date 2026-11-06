import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { GREP_PATTERNS } from "../scripts/run-benchmark";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const published = (JSON.parse(read("../docs/benchmarks-v2.json")) as {
  samples: { ashlr__grep: { pattern: string }[] };
}).samples.ashlr__grep.map((s) => s.pattern);

test("runner and benchmarks-v2.json list the same grep patterns in the same order", () => {
  expect(published).toEqual([...GREP_PATTERNS]);
});

test("inventory doc table matches the runner patterns exactly", () => {
  const doc = read("../docs/benchmark-grep-pattern-inventory.md");
  const rows = [...doc.matchAll(/^\| \d+ \| `"([^`]*)"`\s*\|/gm)].map((m) => m[1]);
  expect(rows).toEqual([...GREP_PATTERNS]);
  expect(doc).toContain("Only in the runner: none.");
  expect(doc).toContain("Only in `benchmarks-v2.json`: none.");
});
