/**
 * scripts/_benchmark-v2-schema.ts
 *
 * Dependency-free schema validator for docs/benchmarks-v2.json (and the
 * site/public copy the site serves). The shape is the union of what
 * scripts/run-benchmark.ts writes (version/measuredAt/repo/samples/aggregate/
 * methodology, optional heuristicError) and what scripts/benchmark-refs.ts
 * merges in (byRepo/byLanguage/crossLanguage*/crossLanguageMeasuredAt), plus
 * the optional caveat note.
 *
 * Both writers self-check through this module before writing; the schema test
 * (__tests__/benchmark-v2-schema.test.ts) pins the published snapshots and
 * proves malformed data is rejected.
 *
 * Validation returns a list of human-readable errors; an empty list means the
 * document conforms.
 */

const SIZE_BUCKETS = ["2-5KB", "5-15KB", "15-50KB", "50+KB"] as const;
const EDIT_SIZES = ["small", "medium", "large"] as const;
const GREP_METHODS = ["rg-truncated"] as const;
const TOOLS = ["ashlr__read", "ashlr__grep", "ashlr__edit"] as const;
const PER_TOOL_KEYS = ["read", "grep", "edit"] as const;
const SECTION_KEYS = [
  "byRepo",
  "byLanguage",
  "crossLanguageMean",
  "crossLanguageSavingsPct",
  "crossLanguageMeasuredAt",
] as const;

type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkNonEmptyString(record: ObjectValue, key: string, path: string, errors: string[]): void {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path}.${key}: expected a nonempty string`);
  }
}

function checkFiniteNumber(
  record: ObjectValue,
  key: string,
  path: string,
  errors: string[],
  { min = 0 }: { min?: number } = {},
): void {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path}.${key}: expected a finite number`);
  } else if (value < min) {
    errors.push(`${path}.${key}: expected a number >= ${min}`);
  }
}

function checkTimestamp(record: ObjectValue, key: string, path: string, errors: string[]): void {
  const value = record[key];
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${path}.${key}: expected a parseable timestamp string`);
  }
}

function checkEnum(
  record: ObjectValue,
  key: string,
  path: string,
  allowed: readonly string[],
  errors: string[],
): void {
  const value = record[key];
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push(`${path}.${key}: expected one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`);
  }
}

function checkToolAggregate(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  checkFiniteNumber(value, "mean", path, errors);
  checkFiniteNumber(value, "p50", path, errors);
  checkFiniteNumber(value, "p90", path, errors);
  const ci = value.confidenceInterval;
  if (!isObject(ci)) {
    errors.push(`${path}.confidenceInterval: expected an object`);
    return;
  }
  checkFiniteNumber(ci, "lo", `${path}.confidenceInterval`, errors);
  checkFiniteNumber(ci, "hi", `${path}.confidenceInterval`, errors);
  if (
    typeof ci.lo === "number" &&
    typeof ci.hi === "number" &&
    Number.isFinite(ci.lo) &&
    Number.isFinite(ci.hi) &&
    ci.lo > ci.hi
  ) {
    errors.push(`${path}.confidenceInterval: lo must be <= hi`);
  }
}

function checkReadSample(sample: ObjectValue, path: string, errors: string[]): void {
  checkNonEmptyString(sample, "path", path, errors);
  checkEnum(sample, "bucket", path, SIZE_BUCKETS, errors);
  for (const key of ["rawBytes", "rawTokens", "ashlrBytes", "ashlrTokens", "ratio"]) {
    checkFiniteNumber(sample, key, path, errors);
  }
}

function checkGrepSample(sample: ObjectValue, path: string, errors: string[]): void {
  checkNonEmptyString(sample, "pattern", path, errors);
  checkEnum(sample, "method", path, GREP_METHODS, errors);
  for (const key of ["rawBytes", "rawTokens", "ashlrBytes", "ashlrTokens", "ratio"]) {
    checkFiniteNumber(sample, key, path, errors);
  }
}

function checkEditSample(sample: ObjectValue, path: string, errors: string[]): void {
  checkEnum(sample, "size", path, EDIT_SIZES, errors);
  for (const key of [
    "searchChars",
    "replaceChars",
    "naiveBytes",
    "naiveTokens",
    "ashlrBytes",
    "ashlrTokens",
    "ratio",
  ]) {
    checkFiniteNumber(sample, key, path, errors);
  }
}

const SAMPLE_CHECKS: Record<(typeof TOOLS)[number], (s: ObjectValue, p: string, e: string[]) => void> = {
  ashlr__read: checkReadSample,
  ashlr__grep: checkGrepSample,
  ashlr__edit: checkEditSample,
};

/**
 * Any record anywhere in the document that carries a `pattern` key must carry
 * a nonempty string — a blank pattern means a benchmark entry that cannot be
 * reproduced or audited.
 */
function checkPatterns(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) checkPatterns(value[i], `${path}[${i}]`, errors);
    return;
  }
  if (!isObject(value)) return;
  if ("pattern" in value) checkNonEmptyString(value, "pattern", path || "$", errors);
  for (const key of Object.keys(value)) {
    checkPatterns(value[key], path ? `${path}.${key}` : key, errors);
  }
}

/**
 * Validate the multi-repo sections merged in by scripts/benchmark-refs.ts.
 * All five section keys are required here; the full-document validator only
 * applies this when any of them is present (a plain run-benchmark output has
 * none).
 */
export function validateBenchmarkV2Sections(record: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(record)) return ["$: expected an object"];

  checkTimestamp(record, "crossLanguageMeasuredAt", "$", errors);
  checkFiniteNumber(record, "crossLanguageMean", "$", errors);
  checkFiniteNumber(record, "crossLanguageSavingsPct", "$", errors);

  const byLanguage = record.byLanguage;
  if (!isObject(byLanguage)) {
    errors.push("$.byLanguage: expected an object");
  } else {
    for (const key of Object.keys(byLanguage)) {
      const entry = byLanguage[key];
      const path = `$.byLanguage.${key}`;
      if (!isObject(entry)) {
        errors.push(`${path}: expected an object`);
        continue;
      }
      checkNonEmptyString(entry, "language", path, errors);
      checkFiniteNumber(entry, "meanRatio", path, errors);
      checkFiniteNumber(entry, "savingsPct", path, errors);
    }
  }

  const byRepo = record.byRepo;
  if (!isObject(byRepo)) {
    errors.push("$.byRepo: expected an object");
  } else {
    for (const key of Object.keys(byRepo)) {
      const entry = byRepo[key];
      const path = `$.byRepo.${key}`;
      if (!isObject(entry)) {
        errors.push(`${path}: expected an object`);
        continue;
      }
      for (const field of ["repoKey", "language", "upstreamRepo", "refrev"]) {
        checkNonEmptyString(entry, field, path, errors);
      }
      checkFiniteNumber(entry, "meanRatio", path, errors);
      checkFiniteNumber(entry, "savingsPct", path, errors);
      const perTool = entry.perTool;
      if (!isObject(perTool)) {
        errors.push(`${path}.perTool: expected an object`);
        continue;
      }
      for (const tool of PER_TOOL_KEYS) {
        const stats = perTool[tool];
        const toolPath = `${path}.perTool.${tool}`;
        if (!isObject(stats)) {
          errors.push(`${toolPath}: expected an object`);
          continue;
        }
        checkFiniteNumber(stats, "mean", toolPath, errors);
        checkFiniteNumber(stats, "p50", toolPath, errors);
        checkFiniteNumber(stats, "p90", toolPath, errors);
      }
    }
  }

  return errors;
}

/**
 * Validate a full benchmarks-v2 document. Returns a list of errors; empty
 * means valid. Sample arrays may be empty (run-benchmark on an empty repo is
 * a legitimate result); a document that fails any check is rejected.
 */
export function validateBenchmarkV2(data: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(data)) return ["$: expected a top-level object"];

  if (data.version !== 2) errors.push("$.version: expected 2");
  checkTimestamp(data, "measuredAt", "$", errors);
  checkNonEmptyString(data, "methodology", "$", errors);

  const repo = data.repo;
  if (!isObject(repo)) {
    errors.push("$.repo: expected an object");
  } else {
    checkNonEmptyString(repo, "url", "$.repo", errors);
    checkNonEmptyString(repo, "commit", "$.repo", errors);
    checkFiniteNumber(repo, "files", "$.repo", errors);
    checkFiniteNumber(repo, "loc", "$.repo", errors);
  }

  const samples = data.samples;
  if (!isObject(samples)) {
    errors.push("$.samples: expected an object");
  } else {
    for (const tool of TOOLS) {
      const entries = samples[tool];
      const path = `$.samples.${tool}`;
      if (!Array.isArray(entries)) {
        errors.push(`${path}: expected an array`);
        continue;
      }
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const entryPath = `${path}[${i}]`;
        if (!isObject(entry)) {
          errors.push(`${entryPath}: expected an object`);
          continue;
        }
        SAMPLE_CHECKS[tool](entry, entryPath, errors);
      }
    }
  }

  const aggregate = data.aggregate;
  if (!isObject(aggregate)) {
    errors.push("$.aggregate: expected an object");
  } else {
    for (const tool of TOOLS) {
      checkToolAggregate(aggregate[tool], `$.aggregate.${tool}`, errors);
    }
    const overall = aggregate.overall;
    if (!isObject(overall)) {
      errors.push("$.aggregate.overall: expected an object");
    } else {
      checkFiniteNumber(overall, "mean", "$.aggregate.overall", errors);
    }
  }

  // Optional fields emitted only in some flows.
  if ("heuristicError" in data && data.heuristicError !== null) {
    checkFiniteNumber(data, "heuristicError", "$", errors);
  }
  if ("caveat" in data) checkNonEmptyString(data, "caveat", "$", errors);
  if (SECTION_KEYS.some((key) => key in data)) {
    errors.push(...validateBenchmarkV2Sections(data));
  }

  checkPatterns(data, "", errors);
  return errors;
}
