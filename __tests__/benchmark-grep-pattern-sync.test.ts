import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const docsPath = "../docs/benchmarks-v2.json";
const publicPath = "../site/public/benchmarks-v2.json";

function grepPatterns(data: unknown, source: string): Set<string> {
  const samples = (data as { samples?: { ashlr__grep?: unknown } } | null)?.samples?.ashlr__grep;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error(`${source}: samples.ashlr__grep must be a non-empty array`);
  }

  return new Set(samples.map((sample: unknown, index: number) => {
    const pattern = (sample as { pattern?: unknown } | null)?.pattern;
    if (typeof pattern !== "string" || !pattern.trim()) {
      throw new Error(`${source}: samples.ashlr__grep[${index}].pattern must be a non-empty string`);
    }
    return pattern;
  }));
}

function compareGrepPatterns(documented: Set<string>, published: Set<string>): void {
  const onlyInDocs = [...documented].filter((pattern) => !published.has(pattern)).sort();
  const onlyInPublic = [...published].filter((pattern) => !documented.has(pattern)).sort();
  if (onlyInDocs.length || onlyInPublic.length) {
    throw new Error(
      `Benchmark grep patterns differ:\n` +
      `Only in docs/benchmarks-v2.json: ${JSON.stringify(onlyInDocs)}\n` +
      `Only in site/public/benchmarks-v2.json: ${JSON.stringify(onlyInPublic)}`,
    );
  }
}

function readPatterns(path: string): Set<string> {
  return grepPatterns(JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")), path);
}

test("published benchmark grep patterns match the documented samples", () => {
  compareGrepPatterns(readPatterns(docsPath), readPatterns(publicPath));
});

test("comparison ignores sample order and duplicates", () => {
  const data = (patterns: string[]) => ({ samples: { ashlr__grep: patterns.map((pattern) => ({ pattern })) } });
  expect(() => compareGrepPatterns(
    grepPatterns(data(["function ", "TODO", "TODO"]), "docs"),
    grepPatterns(data(["TODO", "function "]), "public"),
  )).not.toThrow();
});

test("comparison reports patterns unique to each file, preserving whitespace", () => {
  expect(() => compareGrepPatterns(
    new Set(["function ", "docs only"]),
    new Set(["function", "public only"]),
  )).toThrow(
    'Only in docs/benchmarks-v2.json: ["docs only","function "]\n' +
    'Only in site/public/benchmarks-v2.json: ["function","public only"]',
  );
});

test("rejects missing, empty, or invalid grep samples", () => {
  for (const data of [null, {}, { samples: { ashlr__grep: [] } }]) {
    expect(() => grepPatterns(data, "fixture")).toThrow("fixture: samples.ashlr__grep must be a non-empty array");
  }
  for (const sample of [null, {}, { pattern: 1 }, { pattern: " " }]) {
    expect(() => grepPatterns({ samples: { ashlr__grep: [sample] } }, "fixture"))
      .toThrow("fixture: samples.ashlr__grep[0].pattern must be a non-empty string");
  }
});
