import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const docsPath = new URL("../docs/benchmarks-v2.json", import.meta.url);
const publicPath = new URL("../site/public/benchmarks-v2.json", import.meta.url);

const tools = ["ashlr__read", "ashlr__grep", "ashlr__edit"] as const;

function loadBenchmarks(path: URL, label: string) {
  const raw = readFileSync(path, "utf8");
  const data = JSON.parse(raw);
  return { label, path: path.href, data };
}

const docs = loadBenchmarks(docsPath, "docs");
const public_ = loadBenchmarks(publicPath, "public");

function almostEqual(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) < tol;
}

describe("benchmark-v2 data comparison: docs vs site/public", () => {
  test("both files are valid JSON with version 2", () => {
    expect(docs.data.version).toBe(2);
    expect(public_.data.version).toBe(2);
    expect(docs.data.version).toBe(public_.data.version);
  });

  test("top-level keys are identical", () => {
    const docsKeys = Object.keys(docs.data).sort();
    const publicKeys = Object.keys(public_.data).sort();
    expect(docsKeys).toEqual(publicKeys);
  });

  test("measuredAt timestamp is identical", () => {
    expect(docs.data.measuredAt).toBe(public_.data.measuredAt);
  });

  test("repo metadata matches (url, commit, files, loc)", () => {
    const dr = docs.data.repo;
    const pr = public_.data.repo;
    expect(dr.url).toBe(pr.url);
    expect(dr.commit).toBe(pr.commit);
    expect(dr.files).toBe(pr.files);
    expect(dr.loc).toBe(pr.loc);
  });

  test("grep pattern sequences match", () => {
    const docPatterns = docs.data.samples.ashlr__grep.map((s: { pattern: string }) => s.pattern);
    const pubPatterns = public_.data.samples.ashlr__grep.map((s: { pattern: string }) => s.pattern);
    expect(docPatterns).toEqual(pubPatterns);
  });

  test("grep sample counts match", () => {
    expect(docs.data.samples.ashlr__grep.length).toBe(public_.data.samples.ashlr__grep.length);
  });

  test("grep sample raw bytes and tokens match", () => {
    const docSamples = docs.data.samples.ashlr__grep;
    const pubSamples = public_.data.samples.ashlr__grep;
    for (let i = 0; i < docSamples.length; i++) {
      expect(docSamples[i].rawBytes, `rawBytes[${i}]`).toBe(pubSamples[i].rawBytes);
      expect(docSamples[i].rawTokens, `rawTokens[${i}]`).toBe(pubSamples[i].rawTokens);
      expect(docSamples[i].ashlrBytes, `ashlrBytes[${i}]`).toBe(pubSamples[i].ashlrBytes);
      expect(docSamples[i].ashlrTokens, `ashlrTokens[${i}]`).toBe(pubSamples[i].ashlrTokens);
      expect(almostEqual(docSamples[i].ratio, pubSamples[i].ratio), `ratio[${i}]`).toBe(true);
    }
  });

  test("read sample counts and paths match", () => {
    const docRead = docs.data.samples.ashlr__read;
    const pubRead = public_.data.samples.ashlr__read;
    expect(docRead.length).toBe(pubRead.length);
    const docPaths = docRead.map((s: { path: string }) => s.path).sort();
    const pubPaths = pubRead.map((s: { path: string }) => s.path).sort();
    expect(docPaths).toEqual(pubPaths);
  });

  test("edit sample counts match", () => {
    expect(docs.data.samples.ashlr__edit.length).toBe(public_.data.samples.ashlr__edit.length);
  });

  test("aggregate per-tool stats match", () => {
    const da = docs.data.aggregate;
    const pa = public_.data.aggregate;
    for (const tool of tools) {
      const dtool = da[tool];
      const ptool = pa[tool];
      expect(almostEqual(dtool.mean, ptool.mean), `${tool}.mean`).toBe(true);
      expect(almostEqual(dtool.p50, ptool.p50), `${tool}.p50`).toBe(true);
      expect(almostEqual(dtool.p90, ptool.p90), `${tool}.p90`).toBe(true);
    }
  });

  test("aggregate overall mean matches", () => {
    expect(almostEqual(docs.data.aggregate.overall.mean, public_.data.aggregate.overall.mean)).toBe(true);
  });

  test("byLanguage keys match", () => {
    expect(Object.keys(docs.data.byLanguage).sort()).toEqual(Object.keys(public_.data.byLanguage).sort());
  });

  test("byLanguage meanRatio and savingsPct match", () => {
    const keys = Object.keys(docs.data.byLanguage).sort();
    for (const key of keys) {
      const dl = docs.data.byLanguage[key];
      const pl = public_.data.byLanguage[key];
      expect(almostEqual(dl.meanRatio, pl.meanRatio), `${key}.meanRatio`).toBe(true);
      expect(almostEqual(dl.savingsPct, pl.savingsPct), `${key}.savingsPct`).toBe(true);
    }
  });

  test("byRepo keys match", () => {
    expect(Object.keys(docs.data.byRepo).sort()).toEqual(Object.keys(public_.data.byRepo).sort());
  });

  test("byRepo per-tool aggregate stats match", () => {
    const keys = Object.keys(docs.data.byRepo).sort();
    for (const key of keys) {
      const drepo = docs.data.byRepo[key];
      const prepo = public_.data.byRepo[key];
      expect(drepo.repoKey).toBe(prepo.repoKey);
      expect(almostEqual(drepo.meanRatio, prepo.meanRatio), `${key}.meanRatio`).toBe(true);
      expect(almostEqual(drepo.savingsPct, prepo.savingsPct), `${key}.savingsPct`).toBe(true);
      const perToolKeys = Object.keys(drepo.perTool).sort();
      expect(perToolKeys).toEqual(Object.keys(prepo.perTool).sort());
      for (const t of perToolKeys) {
        const dt = drepo.perTool[t];
        const pt = prepo.perTool[t];
        expect(almostEqual(dt.mean, pt.mean), `${key}.perTool.${t}.mean`).toBe(true);
        expect(almostEqual(dt.p50, pt.p50), `${key}.perTool.${t}.p50`).toBe(true);
        expect(almostEqual(dt.p90, pt.p90), `${key}.perTool.${t}.p90`).toBe(true);
      }
    }
  });

  test("crossLanguage metrics match", () => {
    expect(almostEqual(docs.data.crossLanguageMean, public_.data.crossLanguageMean)).toBe(true);
    expect(almostEqual(docs.data.crossLanguageSavingsPct, public_.data.crossLanguageSavingsPct)).toBe(true);
    expect(docs.data.crossLanguageMeasuredAt).toBe(public_.data.crossLanguageMeasuredAt);
  });

  test("caveat text matches", () => {
    expect(docs.data.caveat).toBe(public_.data.caveat);
  });

  test("methodology fields may legitimately differ", () => {
    // The docs file and published site copy intentionally use different methodology text
    // (the published copy references a slightly different grep description). This test
    // confirms both files have a non-empty methodology field; the text need not match.
    expect(typeof docs.data.methodology).toBe("string");
    expect((docs.data.methodology as string).length).toBeGreaterThan(100);
    expect(typeof public_.data.methodology).toBe("string");
    expect((public_.data.methodology as string).length).toBeGreaterThan(100);
  });
});
