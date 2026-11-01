import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function grepPatterns(path: string): string[] {
  const data = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  return data.samples.ashlr__grep.map((sample: { pattern: string }) => sample.pattern);
}

test("published benchmark grep patterns match the documented samples", () => {
  const documented = grepPatterns("../docs/benchmarks-v2.json");
  const published = grepPatterns("../site/public/benchmarks-v2.json");

  expect(published).toEqual(documented);
});
