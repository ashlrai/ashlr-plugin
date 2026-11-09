import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// docs/benchmarks-v2.json is canonical (written by scripts/run-benchmark.ts).
// site/public/benchmarks-v2.json is the copy the site serves; refresh it with
//   cp docs/benchmarks-v2.json site/public/benchmarks-v2.json
// No fields currently differ in the site copy.
const SITE_ONLY_FIELDS: readonly string[] = [];

type Json = Record<string, unknown>;

function load(file: string): Json {
  return JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as Json;
}

function withoutSiteOnly(data: Json): Json {
  const copy = { ...data };
  for (const key of SITE_ONLY_FIELDS) delete copy[key];
  return copy;
}

const docs = load("docs/benchmarks-v2.json");
const site = load("site/public/benchmarks-v2.json");

describe("docs and site benchmark data agree", () => {
  test("measurement provenance matches", () => {
    expect(site.version).toBe(docs.version);
    expect(site.measuredAt).toBe(docs.measuredAt);
    expect(site.repo).toEqual(docs.repo);
  });

  test("samples and aggregates match", () => {
    expect(site.samples).toEqual(docs.samples);
    expect(site.aggregate).toEqual(docs.aggregate);
  });

  test("every docs field is present in the site copy", () => {
    expect(Object.keys(site).sort()).toEqual(
      [...new Set([...Object.keys(docs), ...SITE_ONLY_FIELDS.filter((k) => k in site)])].sort(),
    );
  });

  test("shared data is identical apart from documented site-only fields", () => {
    expect(withoutSiteOnly(site)).toEqual(withoutSiteOnly(docs));
  });

  test("site-only allowlist has no stale entries", () => {
    for (const key of SITE_ONLY_FIELDS) {
      expect(key in site).toBe(true);
      expect(key in docs).toBe(true);
    }
  });
});
