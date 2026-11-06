import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { validateBenchmarkV2 } from "../scripts/benchmark-schema.ts";

// site/public/benchmarks-v2.json is the copy the site serves at
// /benchmarks-v2.json; docs/benchmarks-v2.json is the canonical copy written
// by scripts/run-benchmark.ts and extended by scripts/benchmark-refs.ts.
// Both must conform to the same published schema.
const files = ["site/public/benchmarks-v2.json", "docs/benchmarks-v2.json"];

type JsonObject = Record<string, unknown>;

function* recordsWithPattern(value: unknown): Generator<JsonObject> {
  if (Array.isArray(value)) {
    for (const entry of value) yield* recordsWithPattern(entry);
  } else if (value !== null && typeof value === "object") {
    const record = value as JsonObject;
    if ("pattern" in record) yield record;
    for (const key of Object.keys(record)) yield* recordsWithPattern(record[key]);
  }
}

function validFixture(): JsonObject {
  return {
    version: 2,
    measuredAt: "2026-10-19T17:23:26.418Z",
    repo: {
      url: "https://github.com/ashlrai/ashlr-plugin.git",
      commit: "364a4030d3bdb02271c04e18d1632ef6bd00d8f1",
      files: 1294,
      loc: 277392,
    },
    samples: {
      "ashlr__read": [
        {
          path: "src/a.ts",
          bucket: "2-5KB",
          rawBytes: 3805,
          rawTokens: 950,
          ashlrBytes: 1628,
          ashlrTokens: 406,
          ratio: 0.42736842105263156,
        },
      ],
      "ashlr__grep": [
        {
          pattern: "function ",
          rawBytes: 476041,
          rawTokens: 118991,
          ashlrBytes: 3590,
          ashlrTokens: 893,
          ratio: 0.007504769268263986,
          method: "rg-truncated",
        },
      ],
      "ashlr__edit": [
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
      "ashlr__read": { mean: 0.2, p50: 0.2, p90: 0.47, confidenceInterval: { lo: 0.11, hi: 0.3 } },
      "ashlr__grep": { mean: 0.08, p50: 0.04, p90: 0.24, confidenceInterval: { lo: 0.01, hi: 0.17 } },
      "ashlr__edit": { mean: 0.37, p50: 0.11, p90: 1, confidenceInterval: { lo: 0.01, hi: 1 } },
      overall: { mean: 0.2 },
    },
    methodology: "fixture methodology",
  };
}

type Mutable = { [key: string]: any };

/** Returns a deep copy of the valid fixture after applying `mutate`. */
function mutated(mutate: (doc: Mutable) => void): unknown {
  const doc = validFixture();
  mutate(doc as Mutable);
  return doc;
}

describe.each(files)("benchmarks-v2 schema: %s", (file) => {
  const raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

  test("parses as a JSON object", () => {
    const data: unknown = JSON.parse(raw);
    expect(data).not.toBeNull();
    expect(typeof data).toBe("object");
    expect(Array.isArray(data)).toBe(false);
  });

  test("conforms to the benchmarks-v2 schema", () => {
    expect(validateBenchmarkV2(JSON.parse(raw))).toEqual([]);
  });

  test("every benchmark entry carrying a pattern has a non-empty pattern", () => {
    const found = [...recordsWithPattern(JSON.parse(raw))];
    expect(found.length).toBeGreaterThan(0);
    for (const record of found) {
      expect(typeof record.pattern).toBe("string");
      expect((record.pattern as string).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("validateBenchmarkV2", () => {
  test("accepts a minimal conforming document", () => {
    expect(validateBenchmarkV2(validFixture())).toEqual([]);
  });

  test("accepts the benchmark-refs sections when present", () => {
    const doc = validFixture();
    doc.byLanguage = {
      ts: { language: "ts", meanRatio: 0.4, savingsPct: 59.98 },
    };
    doc.byRepo = {
      "node-sdk": {
        repoKey: "node-sdk",
        language: "ts",
        upstreamRepo: "github.com/vercel/ai",
        refrev: "049801243cc791e0ba28910b8a638f0e05446bcd",
        meanRatio: 0.4,
        savingsPct: 59.98,
        perTool: {
          read: { mean: 0.25, p50: 0.2, p90: 0.56 },
          grep: { mean: 0.69, p50: 1, p90: 1 },
          edit: { mean: 0.5, p50: 0.48, p90: 1 },
        },
      },
    };
    doc.crossLanguageMean = 0.4;
    doc.crossLanguageSavingsPct = 59.54;
    doc.crossLanguageMeasuredAt = "2026-10-17T02:32:44.002Z";
    doc.caveat = "Synthetic benchmark.";
    doc.heuristicError = null;
    expect(validateBenchmarkV2(doc)).toEqual([]);
  });

  test.each<[string, unknown]>([
    ["null", null],
    ["a string", "benchmarks"],
    ["a number", 42],
    ["an array", []],
    ["an empty object", {}],
  ])("rejects a non-conforming root: %s", (_name, data) => {
    expect(validateBenchmarkV2(data).length).toBeGreaterThan(0);
  });

  // Each case mutates the valid fixture into malformed data; the validator
  // must reject it and report the expected path.
  const cases: Array<[string, unknown, string]> = [
    ["version 1", mutated((d) => { d.version = 1; }), "version"],
    ["version as a string", mutated((d) => { d.version = "2"; }), "version"],
    ["missing measuredAt", mutated((d) => { delete d.measuredAt; }), "measuredAt"],
    ["empty measuredAt", mutated((d) => { d.measuredAt = ""; }), "measuredAt"],
    ["unparseable measuredAt", mutated((d) => { d.measuredAt = "not a date"; }), "measuredAt"],
    ["missing repo", mutated((d) => { delete d.repo; }), "repo"],
    ["non-sha repo.commit", mutated((d) => { d.repo.commit = "abc123"; }), "repo.commit"],
    ["empty repo.url", mutated((d) => { d.repo.url = " "; }), "repo.url"],
    ["negative repo.files", mutated((d) => { d.repo.files = -1; }), "repo.files"],
    ["non-numeric repo.loc", mutated((d) => { d.repo.loc = "lots"; }), "repo.loc"],
    ["missing samples", mutated((d) => { delete d.samples; }), "samples"],
    ["empty grep samples", mutated((d) => { d.samples["ashlr__grep"] = []; }), "samples.ashlr__grep"],
    ["grep samples not an array", mutated((d) => { d.samples["ashlr__grep"] = {}; }), "samples.ashlr__grep"],
    ["missing grep pattern", mutated((d) => { delete d.samples["ashlr__grep"][0].pattern; }), "samples.ashlr__grep[0].pattern"],
    ["empty grep pattern", mutated((d) => { d.samples["ashlr__grep"][0].pattern = ""; }), "samples.ashlr__grep[0].pattern"],
    ["blank grep pattern", mutated((d) => { d.samples["ashlr__grep"][0].pattern = "   "; }), "samples.ashlr__grep[0].pattern"],
    ["numeric grep pattern", mutated((d) => { d.samples["ashlr__grep"][0].pattern = 42; }), "samples.ashlr__grep[0].pattern"],
    ["null grep pattern", mutated((d) => { d.samples["ashlr__grep"][0].pattern = null; }), "samples.ashlr__grep[0].pattern"],
    ["unknown grep method", mutated((d) => { d.samples["ashlr__grep"][0].method = "rg-full"; }), "samples.ashlr__grep[0].method"],
    ["missing read path", mutated((d) => { delete d.samples["ashlr__read"][0].path; }), "samples.ashlr__read[0].path"],
    ["unknown read bucket", mutated((d) => { d.samples["ashlr__read"][0].bucket = "huge"; }), "samples.ashlr__read[0].bucket"],
    ["negative read rawBytes", mutated((d) => { d.samples["ashlr__read"][0].rawBytes = -5; }), "samples.ashlr__read[0].rawBytes"],
    ["non-numeric read ratio", mutated((d) => { d.samples["ashlr__read"][0].ratio = "high"; }), "samples.ashlr__read[0].ratio"],
    ["unknown edit size", mutated((d) => { d.samples["ashlr__edit"][0].size = "huge"; }), "samples.ashlr__edit[0].size"],
    ["missing edit naiveBytes", mutated((d) => { delete d.samples["ashlr__edit"][0].naiveBytes; }), "samples.ashlr__edit[0].naiveBytes"],
    ["missing aggregate", mutated((d) => { delete d.aggregate; }), "aggregate"],
    ["missing aggregate tool", mutated((d) => { delete d.aggregate["ashlr__grep"]; }), "aggregate.ashlr__grep"],
    ["missing confidenceInterval", mutated((d) => { delete d.aggregate["ashlr__read"].confidenceInterval; }), "aggregate.ashlr__read.confidenceInterval"],
    ["inverted confidenceInterval", mutated((d) => {
      d.aggregate["ashlr__read"].confidenceInterval = { lo: 0.9, hi: 0.1 };
    }), "aggregate.ashlr__read.confidenceInterval"],
    ["missing overall mean", mutated((d) => { d.aggregate.overall = {}; }), "aggregate.overall.mean"],
    ["missing methodology", mutated((d) => { delete d.methodology; }), "methodology"],
    ["empty methodology", mutated((d) => { d.methodology = ""; }), "methodology"],
    ["non-numeric heuristicError", mutated((d) => { d.heuristicError = "3%"; }), "heuristicError"],
    // A `pattern` field anywhere in the document — not only under
    // samples.ashlr__grep — must hold a non-empty string.
    ["empty nested pattern", mutated((d) => { d.notes = { inner: { pattern: "" } }; }), "notes.inner.pattern"],
    ["numeric nested pattern", mutated((d) => { d.extra = [{ pattern: 7 }]; }), "extra[0].pattern"],
    // benchmark-refs sections are validated when present.
    ["byLanguage key/language mismatch", mutated((d) => {
      d.byLanguage = { ts: { language: "py", meanRatio: 0.4, savingsPct: 60 } };
    }), "byLanguage.ts.language"],
    ["byLanguage non-numeric meanRatio", mutated((d) => {
      d.byLanguage = { ts: { language: "ts", meanRatio: "low", savingsPct: 60 } };
    }), "byLanguage.ts.meanRatio"],
    ["byRepo key/repoKey mismatch", mutated((d) => {
      d.byRepo = {
        "node-sdk": {
          repoKey: "other",
          language: "ts",
          upstreamRepo: "github.com/vercel/ai",
          refrev: "049801243cc791e0ba28910b8a638f0e05446bcd",
          meanRatio: 0.4,
          savingsPct: 60,
          perTool: {
            read: { mean: 0.2, p50: 0.2, p90: 0.5 },
            grep: { mean: 0.6, p50: 1, p90: 1 },
            edit: { mean: 0.5, p50: 0.4, p90: 1 },
          },
        },
      };
    }), "byRepo.node-sdk.repoKey"],
    ["byRepo missing perTool.read", mutated((d) => {
      d.byRepo = {
        "node-sdk": {
          repoKey: "node-sdk",
          language: "ts",
          upstreamRepo: "github.com/vercel/ai",
          refrev: "049801243cc791e0ba28910b8a638f0e05446bcd",
          meanRatio: 0.4,
          savingsPct: 60,
          perTool: {
            grep: { mean: 0.6, p50: 1, p90: 1 },
            edit: { mean: 0.5, p50: 0.4, p90: 1 },
          },
        },
      };
    }), "byRepo.node-sdk.perTool.read"],
    ["unparseable crossLanguageMeasuredAt", mutated((d) => {
      d.crossLanguageMeasuredAt = "someday";
    }), "crossLanguageMeasuredAt"],
    ["empty caveat", mutated((d) => { d.caveat = ""; }), "caveat"],
  ];

  test.each(cases)("rejects malformed fixture: %s", (_name, data, expectedPath) => {
    const problems = validateBenchmarkV2(data);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((problem) => problem.startsWith(`${expectedPath}:`))).toBe(true);
  });
});
