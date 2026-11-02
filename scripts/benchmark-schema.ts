#!/usr/bin/env bun
/**
 * scripts/benchmark-schema.ts
 *
 * Schema validator for benchmarks-v2.json — the canonical copy at
 * docs/benchmarks-v2.json and the copy the site serves at
 * site/public/benchmarks-v2.json. The core fields are written by
 * scripts/run-benchmark.ts; scripts/benchmark-refs.ts merges in the
 * cross-repo sections (byRepo / byLanguage / crossLanguage* / caveat).
 *
 * validateBenchmarkV2(data) returns a list of "<path>: <problem>" strings;
 * an empty list means the document conforms. Required core fields are
 * checked strictly; the benchmark-refs sections are validated when present.
 * Every record carrying a `pattern` field — anywhere in the document — must
 * hold a non-empty string, so a malformed grep sample can never publish.
 *
 * CLI:
 *   bun run scripts/benchmark-schema.ts [file ...]
 *   # defaults to docs/benchmarks-v2.json and site/public/benchmarks-v2.json;
 *   # prints one "<file>: <path>: <problem>" line per violation, exit 1
 */

import { readFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;

const TOOLS = ["ashlr__read", "ashlr__grep", "ashlr__edit"] as const;
const READ_BUCKETS = ["2-5KB", "5-15KB", "15-50KB", "50+KB"] as const;
const EDIT_SIZES = ["small", "medium", "large"] as const;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): boolean {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function checkObject(problems: string[], value: unknown, path: string): JsonObject | undefined {
  if (!isObject(value)) {
    problems.push(`${path || "$"}: must be an object`);
    return undefined;
  }
  return value;
}

function field(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function checkString(problems: string[], obj: JsonObject, key: string, path: string): void {
  if (!isNonEmptyString(obj[key])) {
    problems.push(`${field(path, key)}: must be a non-empty string`);
  }
}

function checkNumber(
  problems: string[],
  obj: JsonObject,
  key: string,
  path: string,
  opts: { min?: number } = {},
): void {
  const value = obj[key];
  if (!isFiniteNumber(value)) {
    problems.push(`${field(path, key)}: must be a finite number`);
  } else if (opts.min !== undefined && value < opts.min) {
    problems.push(`${field(path, key)}: must be >= ${opts.min}`);
  }
}

function checkEnum(
  problems: string[],
  obj: JsonObject,
  key: string,
  path: string,
  allowed: readonly string[],
): void {
  const value = obj[key];
  if (typeof value !== "string" || !allowed.includes(value)) {
    problems.push(`${field(path, key)}: must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`);
  }
}

function checkToolAggregate(problems: string[], value: unknown, path: string): void {
  const agg = checkObject(problems, value, path);
  if (!agg) return;
  for (const key of ["mean", "p50", "p90"]) checkNumber(problems, agg, key, path, { min: 0 });
  const ci = checkObject(problems, agg.confidenceInterval, `${path}.confidenceInterval`);
  if (!ci) return;
  checkNumber(problems, ci, "lo", `${path}.confidenceInterval`, { min: 0 });
  checkNumber(problems, ci, "hi", `${path}.confidenceInterval`, { min: 0 });
  if (isFiniteNumber(ci.lo) && isFiniteNumber(ci.hi) && ci.lo > ci.hi) {
    problems.push(`${path}.confidenceInterval: lo must be <= hi`);
  }
}

function checkSampleArray(
  problems: string[],
  value: unknown,
  path: string,
  each: (sample: JsonObject, path: string) => void,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${path}: must be a non-empty array`);
    return;
  }
  value.forEach((entry: unknown, i: number) => {
    const sample = checkObject(problems, entry, `${path}[${i}]`);
    if (sample) each(sample, `${path}[${i}]`);
  });
}

function checkReadSample(problems: string[], sample: JsonObject, path: string): void {
  checkString(problems, sample, "path", path);
  checkEnum(problems, sample, "bucket", path, READ_BUCKETS);
  for (const key of ["rawBytes", "rawTokens", "ashlrBytes", "ashlrTokens", "ratio"]) {
    checkNumber(problems, sample, key, path, { min: 0 });
  }
}

function checkGrepSample(problems: string[], sample: JsonObject, path: string): void {
  checkString(problems, sample, "pattern", path);
  checkEnum(problems, sample, "method", path, ["rg-truncated"]);
  for (const key of ["rawBytes", "rawTokens", "ashlrBytes", "ashlrTokens", "ratio"]) {
    checkNumber(problems, sample, key, path, { min: 0 });
  }
}

function checkEditSample(problems: string[], sample: JsonObject, path: string): void {
  checkEnum(problems, sample, "size", path, EDIT_SIZES);
  for (const key of [
    "searchChars",
    "replaceChars",
    "naiveBytes",
    "naiveTokens",
    "ashlrBytes",
    "ashlrTokens",
    "ratio",
  ]) {
    checkNumber(problems, sample, key, path, { min: 0 });
  }
}

function checkRatioStats(problems: string[], value: unknown, path: string): void {
  const stats = checkObject(problems, value, path);
  if (!stats) return;
  checkNumber(problems, stats, "meanRatio", path, { min: 0 });
  checkNumber(problems, stats, "savingsPct", path);
}

function checkByLanguage(problems: string[], value: unknown): void {
  const byLanguage = checkObject(problems, value, "byLanguage");
  if (!byLanguage) return;
  for (const [key, entry] of Object.entries(byLanguage)) {
    const path = `byLanguage.${key}`;
    const lang = checkObject(problems, entry, path);
    if (!lang) continue;
    if (lang.language !== key) {
      problems.push(`${path}.language: must equal its key ${JSON.stringify(key)}`);
    }
    checkRatioStats(problems, lang, path);
  }
}

function checkByRepo(problems: string[], value: unknown): void {
  const byRepo = checkObject(problems, value, "byRepo");
  if (!byRepo) return;
  for (const [key, entry] of Object.entries(byRepo)) {
    const path = `byRepo.${key}`;
    const repo = checkObject(problems, entry, path);
    if (!repo) continue;
    if (repo.repoKey !== key) {
      problems.push(`${path}.repoKey: must equal its key ${JSON.stringify(key)}`);
    }
    checkString(problems, repo, "language", path);
    checkString(problems, repo, "upstreamRepo", path);
    checkString(problems, repo, "refrev", path);
    checkRatioStats(problems, repo, path);
    const perTool = checkObject(problems, repo.perTool, `${path}.perTool`);
    if (!perTool) continue;
    for (const tool of ["read", "grep", "edit"]) {
      const stats = checkObject(problems, perTool[tool], `${path}.perTool.${tool}`);
      if (!stats) continue;
      for (const stat of ["mean", "p50", "p90"]) {
        checkNumber(problems, stats, stat, `${path}.perTool.${tool}`, { min: 0 });
      }
      if (stats.confidenceInterval !== undefined) {
        checkToolAggregate(problems, stats, `${path}.perTool.${tool}`);
      }
    }
  }
}

/** Yields every record in the document that carries a `pattern` field. */
function* recordsWithPattern(
  value: unknown,
  path: string,
): Generator<{ path: string; record: JsonObject }> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* recordsWithPattern(value[i], `${path}[${i}]`);
  } else if (isObject(value)) {
    if ("pattern" in value) yield { path, record: value };
    for (const key of Object.keys(value)) {
      yield* recordsWithPattern(value[key], path ? `${path}.${key}` : key);
    }
  }
}

/**
 * Validates parsed benchmarks-v2.json data. Returns a list of
 * "<path>: <problem>" strings; an empty list means the document conforms to
 * the published schema.
 */
export function validateBenchmarkV2(data: unknown): string[] {
  const problems: string[] = [];

  const root = checkObject(problems, data, "");
  if (!root) return problems;

  if (root.version !== 2) problems.push("version: must be 2");
  if (!isIsoDate(root.measuredAt)) {
    problems.push("measuredAt: must be a non-empty ISO date string");
  }

  const repo = checkObject(problems, root.repo, "repo");
  if (repo) {
    checkString(problems, repo, "url", "repo");
    if (typeof repo.commit !== "string" || !COMMIT_SHA.test(repo.commit)) {
      problems.push("repo.commit: must be a 40-hex commit SHA");
    }
    checkNumber(problems, repo, "files", "repo", { min: 0 });
    checkNumber(problems, repo, "loc", "repo", { min: 0 });
  }

  const samples = checkObject(problems, root.samples, "samples");
  if (samples) {
    checkSampleArray(problems, samples["ashlr__read"], "samples.ashlr__read", (s, p) =>
      checkReadSample(problems, s, p));
    checkSampleArray(problems, samples["ashlr__grep"], "samples.ashlr__grep", (s, p) =>
      checkGrepSample(problems, s, p));
    checkSampleArray(problems, samples["ashlr__edit"], "samples.ashlr__edit", (s, p) =>
      checkEditSample(problems, s, p));
  }

  const aggregate = checkObject(problems, root.aggregate, "aggregate");
  if (aggregate) {
    for (const tool of TOOLS) {
      checkToolAggregate(problems, aggregate[tool], `aggregate.${tool}`);
    }
    const overall = checkObject(problems, aggregate.overall, "aggregate.overall");
    if (overall) checkNumber(problems, overall, "mean", "aggregate.overall", { min: 0 });
  }

  checkString(problems, root, "methodology", "");

  if (root.heuristicError !== undefined && root.heuristicError !== null) {
    checkNumber(problems, root, "heuristicError", "");
  }

  // benchmark-refs sections: optional in the document, strict when present.
  if (root.byLanguage !== undefined) checkByLanguage(problems, root.byLanguage);
  if (root.byRepo !== undefined) checkByRepo(problems, root.byRepo);
  if (root.crossLanguageMean !== undefined) {
    checkNumber(problems, root, "crossLanguageMean", "", { min: 0 });
  }
  if (root.crossLanguageSavingsPct !== undefined) {
    checkNumber(problems, root, "crossLanguageSavingsPct", "");
  }
  if (root.crossLanguageMeasuredAt !== undefined && !isIsoDate(root.crossLanguageMeasuredAt)) {
    problems.push("crossLanguageMeasuredAt: must be a non-empty ISO date string");
  }
  if (root.caveat !== undefined) checkString(problems, root, "caveat", "");

  // Document-wide rule: any benchmark entry that carries a `pattern` field
  // must hold a non-empty string — not only samples.ashlr__grep entries.
  for (const { path, record } of recordsWithPattern(data, "")) {
    if (!isNonEmptyString(record.pattern)) {
      problems.push(`${field(path, "pattern")}: must be a non-empty string`);
    }
  }

  return problems;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const targets = argv.length > 0
    ? argv
    : ["docs/benchmarks-v2.json", "site/public/benchmarks-v2.json"];

  let failed = false;
  for (const file of targets) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, "utf-8"));
    } catch (error) {
      console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
      continue;
    }
    const problems = validateBenchmarkV2(data);
    for (const problem of problems) console.error(`${file}: ${problem}`);
    if (problems.length > 0) failed = true;
    else console.log(`${file}: OK`);
  }
  process.exit(failed ? 1 : 0);
}
