import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// docs/benchmarks-v2.json is the generated source; site/public/benchmarks-v2.json
// is the copy the website serves. They must hold identical benchmark data.

const docsPath = new URL("../docs/benchmarks-v2.json", import.meta.url);
const publicPath = new URL("../site/public/benchmarks-v2.json", import.meta.url);

type Json = unknown;

/** Dotted paths where `a` and `b` differ, e.g. `samples.ashlr__grep[2].rawBytes`. */
export function diffPaths(a: Json, b: Json, path = ""): string[] {
  if (Object.is(a, b)) return [];
  const aObj = typeof a === "object" && a !== null;
  const bObj = typeof b === "object" && b !== null;
  if (!aObj || !bObj || Array.isArray(a) !== Array.isArray(b)) return [path || "(root)"];
  const out: string[] = [];
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) out.push(...diffPaths(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  const ao = a as Record<string, Json>;
  const bo = b as Record<string, Json>;
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    out.push(...diffPaths(ao[k], bo[k], path ? `${path}.${k}` : k));
  }
  return out;
}

describe("diffPaths", () => {
  test("reports nothing for equal data", () => {
    expect(diffPaths({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
  });

  test("names each mismatched path, including missing keys and array length", () => {
    expect(diffPaths({ a: [1, 2], b: 1, c: 1 }, { a: [1, 3, 4], b: 1, d: 1 }).sort()).toEqual(
      ["a[1]", "a[2]", "c", "d"],
    );
  });
});

describe("benchmarks-v2.json: docs vs site/public", () => {
  const docs = JSON.parse(readFileSync(docsPath, "utf8"));
  const site = JSON.parse(readFileSync(publicPath, "utf8"));

  test("benchmark data is identical", () => {
    const mismatches = diffPaths(docs, site);
    expect(
      mismatches,
      `docs/benchmarks-v2.json and site/public/benchmarks-v2.json differ at: ${mismatches.join(", ")}. ` +
        `Regenerate or copy the docs file's data into the site copy`,
    ).toEqual([]);
  });
});
