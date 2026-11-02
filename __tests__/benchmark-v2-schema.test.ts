import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { validateBenchmarkV2, validateBenchmarkV2Sections } from "../scripts/_benchmark-v2-schema";

// docs/benchmarks-v2.json is canonical (written by scripts/run-benchmark.ts and
// extended by scripts/benchmark-refs.ts); site/public/benchmarks-v2.json is the
// copy the site serves. Both must satisfy the shared v2 schema.
const files = ["docs/benchmarks-v2.json", "site/public/benchmarks-v2.json"];
const tools = ["ashlr__read", "ashlr__grep", "ashlr__edit"] as const;

type ObjectValue = Record<string, unknown>;

const load = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

function* recordsWithPattern(value: unknown, path: string): Generator<{ path: string; record: ObjectValue }> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* recordsWithPattern(value[i], `${path}[${i}]`);
  } else if (value !== null && typeof value === "object") {
    const record = value as ObjectValue;
    if ("pattern" in record) yield { path, record };
    for (const key of Object.keys(record)) yield* recordsWithPattern(record[key], path ? `${path}.${key}` : key);
  }
}

function clone(value: unknown): ObjectValue {
  return JSON.parse(JSON.stringify(value)) as ObjectValue;
}

function minimalValidDocument(): ObjectValue {
  const aggregate = { mean: 0.2, p50: 0.2, p90: 0.4, confidenceInterval: { lo: 0.1, hi: 0.3 } };
  return {
    version: 2,
    measuredAt: "2026-10-19T17:23:26.418Z",
    repo: { url: "https://example.com/repo.git", commit: "abc123", files: 10, loc: 1000 },
    samples: {
      ashlr__read: [
        {
          path: "/repo/src/a.ts",
          bucket: "2-5KB",
          rawBytes: 3000,
          rawTokens: 750,
          ashlrBytes: 1600,
          ashlrTokens: 400,
          ratio: 0.5,
        },
      ],
      ashlr__grep: [
        {
          pattern: "TODO",
          rawBytes: 5000,
          rawTokens: 1250,
          ashlrBytes: 3600,
          ashlrTokens: 900,
          ratio: 0.72,
          method: "rg-truncated",
        },
      ],
      ashlr__edit: [
        {
          size: "small",
          searchChars: 15,
          replaceChars: 15,
          naiveBytes: 47,
          naiveTokens: 12,
          ashlrBytes: 47,
          ashlrTokens: 12,
          ratio: 1,
        },
      ],
    },
    aggregate: {
      ashlr__read: aggregate,
      ashlr__grep: aggregate,
      ashlr__edit: aggregate,
      overall: { mean: 0.2 },
    },
    methodology: "Measurement methodology (version 2): …",
  };
}

describe.each(files)("%s schema", (file) => {
  test("conforms to the benchmarks-v2 schema with zero errors", () => {
    expect(validateBenchmarkV2(load(file))).toEqual([]);
  });

  test("every benchmark entry carrying a pattern field has a nonempty pattern", () => {
    const found = [...recordsWithPattern(load(file), "")];
    expect(found.length).toBeGreaterThan(0);
    for (const { path, record } of found) {
      expect(typeof record.pattern, path).toBe("string");
      expect((record.pattern as string).trim().length, path).toBeGreaterThan(0);
    }
  });
});

describe("benchmarks-v2 schema malformed fixtures", () => {
  const docs = load("docs/benchmarks-v2.json") as ObjectValue;

  test.each<[string, (data: ObjectValue) => void, RegExp]>([
    ["blank grep pattern", (d) => { (d.samples as ObjectValue).ashlr__grep = [{ ...(d.samples as { ashlr__grep: ObjectValue[] }).ashlr__grep[0]!, pattern: "" }]; }, /pattern/],
    ["whitespace-only grep pattern", (d) => { (d.samples as { ashlr__grep: ObjectValue[] }).ashlr__grep[0]!.pattern = "   "; }, /pattern/],
    ["non-string grep pattern", (d) => { (d.samples as { ashlr__grep: ObjectValue[] }).ashlr__grep[0]!.pattern = 42; }, /pattern/],
    ["pattern blanked in a nested record", (d) => { (d.byRepo as ObjectValue)["node-sdk"] = { ...(d.byRepo as ObjectValue)["node-sdk"] as ObjectValue, pattern: "" }; }, /pattern/],
    ["version bumped to 3", (d) => { d.version = 3; }, /version/],
    ["version removed", (d) => { delete d.version; }, /version/],
    ["unparseable measuredAt", (d) => { d.measuredAt = "not-a-date"; }, /measuredAt/],
    ["negative repo.files", (d) => { (d.repo as ObjectValue).files = -1; }, /repo\.files/],
    ["samples entry not an array", (d) => { (d.samples as ObjectValue).ashlr__read = "nope"; }, /ashlr__read/],
    ["sample entry not an object", (d) => { (d.samples as { ashlr__read: unknown[] }).ashlr__read[0] = null; }, /ashlr__read\[0\]/],
    ["read sample bad bucket", (d) => { (d.samples as { ashlr__read: ObjectValue[] }).ashlr__read[0]!.bucket = "1-2KB"; }, /bucket/],
    ["read sample NaN ratio", (d) => { (d.samples as { ashlr__read: ObjectValue[] }).ashlr__read[0]!.ratio = Number.NaN; }, /ratio/],
    ["edit sample unknown size", (d) => { (d.samples as { ashlr__edit: ObjectValue[] }).ashlr__edit[0]!.size = "huge"; }, /size/],
    ["confidence interval inverted", (d) => { ((d.aggregate as ObjectValue).ashlr__grep as ObjectValue).confidenceInterval = { lo: 1, hi: 0 }; }, /confidenceInterval/],
    ["missing aggregate tool", (d) => { delete (d.aggregate as ObjectValue).ashlr__edit; }, /aggregate\.ashlr__edit/],
    ["byRepo entry missing refrev", (d) => { delete ((d.byRepo as ObjectValue)["node-sdk"] as ObjectValue).refrev; }, /refrev/],
    ["byRepo perTool missing grep", (d) => { delete (((d.byRepo as ObjectValue)["node-sdk"] as ObjectValue).perTool as ObjectValue).grep; }, /perTool\.grep/],
    ["byLanguage meanRatio non-numeric", (d) => { ((d.byLanguage as ObjectValue).ts as ObjectValue).meanRatio = "high"; }, /meanRatio/],
    ["partial sections (byRepo only)", (d) => { d.byLanguage = (d.byRepo as ObjectValue)["node-sdk"]; for (const k of ["crossLanguageMean", "crossLanguageSavingsPct", "crossLanguageMeasuredAt"]) delete d[k]; }, /crossLanguage/],
  ])("rejects malformed fixture: %s", (_name, mutate, matcher) => {
    const data = clone(docs);
    mutate(data);
    const errors = validateBenchmarkV2(data);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => matcher.test(e))).toBe(true);
  });

  test.each<[string, unknown]>([
    ["null", null],
    ["a string", "not json data"],
    ["a number", 2],
    ["an array", []],
  ])("rejects non-object document: %s", (_name, data) => {
    expect(validateBenchmarkV2(data).length).toBeGreaterThan(0);
  });

  test("accepts a minimal valid document with no optional sections", () => {
    expect(validateBenchmarkV2(minimalValidDocument())).toEqual([]);
  });

  test("accepts empty sample arrays (empty-repo runs are legitimate)", () => {
    const data = minimalValidDocument();
    const samples = data.samples as ObjectValue;
    for (const tool of tools) samples[tool] = [];
    expect(validateBenchmarkV2(data)).toEqual([]);
  });
});

describe("validateBenchmarkV2Sections", () => {
  const docs = load("docs/benchmarks-v2.json") as ObjectValue;

  test("accepts the published multi-repo sections", () => {
    expect(validateBenchmarkV2Sections(docs)).toEqual([]);
  });

  test("rejects non-object input and missing keys", () => {
    expect(validateBenchmarkV2Sections(null).length).toBeGreaterThan(0);
    expect(validateBenchmarkV2Sections({}).length).toBeGreaterThan(0);
  });

  test("rejects a malformed per-tool stat block", () => {
    const data = clone(docs);
    (((data.byRepo as ObjectValue)["python-lib"] as ObjectValue).perTool as ObjectValue).read = { mean: "fast" };
    expect(validateBenchmarkV2Sections(data).some((e) => e.includes("perTool.read"))).toBe(true);
  });
});
