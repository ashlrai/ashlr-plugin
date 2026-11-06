import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// docs/benchmarks-v2.json is canonical (written by scripts/run-benchmark.ts).
// site/public/benchmarks-v2.json is the copy the site serves.
// `methodology` is intentionally allowed to differ—each copy can carry its own
// prose without affecting the shared numeric benchmark values.
const siteOnlyFields = new Set(["methodology"]);

const docs = JSON.parse(
  readFileSync(new URL("../docs/benchmarks-v2.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const site = JSON.parse(
  readFileSync(new URL("../site/public/benchmarks-v2.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** Numeric fields that carry benchmark values at each level. */
const numericFields = new Set([
  // Read samples
  "rawBytes",
  "rawTokens",
  "ashlrBytes",
  "ashlrTokens",
  "ratio",
  // Edit samples
  "searchChars",
  "replaceChars",
  "naiveBytes",
  "naiveTokens",
  // Aggregate stats
  "mean",
  "p50",
  "p90",
  "count",
  "lo",
  "hi",
  // Cross-language sections
  "meanRatio",
  "savingsPct",
  // Repo meta
  "files",
  "loc",
  // Top-level cross-language scalars
  "crossLanguageMean",
  "crossLanguageSavingsPct",
]);

/** Recursively collect all numeric benchmark value paths and their values. */
function collectNumericValues(value: unknown, path: string): Map<string, number> {
  const results = new Map<string, number>();

  if (typeof value === "number") {
    results.set(path, value);
  } else if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const childPath = `${path}[${i}]`;
        // If the array element is a benchmark entry, use a stable key.
        const child = value[i];
        if (child !== null && typeof child === "object" && !Array.isArray(child)) {
          const entry = child as Record<string, unknown>;
          const key =
            "path" in entry
              ? String(entry.path)
              : "pattern" in entry
                ? String(entry.pattern)
                : "size" in entry
                  ? String(entry.size)
                  : "repoKey" in entry
                    ? String(entry.repoKey)
                    : undefined;
          if (key !== undefined) {
            collectNumericValues(child, `${path}[${key}]`).forEach((v, p) => results.set(p, v));
          } else {
            collectNumericValues(child, childPath).forEach((v, p) => results.set(p, v));
          }
        } else {
          collectNumericValues(child, childPath).forEach((v, p) => results.set(p, v));
        }
      }
    } else {
      const obj = value as Record<string, unknown>;
      for (const [key, val] of Object.entries(obj)) {
        if (siteOnlyFields.has(key) && path === "") continue; // skip top-level site-only
        if (numericFields.has(key)) {
          if (typeof val === "number") {
            results.set(`${path}${path ? "." : ""}${key}`, val);
          } else if (val !== null && typeof val === "object") {
            // Fields like confidenceInterval: walk deeper
            collectNumericValues(val, `${path}${path ? "." : ""}${key}`).forEach((v, p) =>
              results.set(p, v),
            );
          }
        } else {
          collectNumericValues(val, `${path}${path ? "." : ""}${key}`).forEach((v, p) =>
            results.set(p, v),
          );
        }
      }
    }
  }
  return results;
}

const docsValues = collectNumericValues(docs, "");
const siteValues = collectNumericValues(site, "");

describe("shared benchmark values parity", () => {
  test("every docs benchmark value has a matching site value", () => {
    const missing: string[] = [];
    for (const path of docsValues.keys()) {
      if (!siteValues.has(path)) {
        missing.push(path);
      }
    }
    expect(missing, "site copy missing values").toEqual([]);
  });

  test("every site benchmark value has a matching docs value", () => {
    const missing: string[] = [];
    for (const path of siteValues.keys()) {
      if (!docsValues.has(path)) {
        missing.push(path);
      }
    }
    expect(missing, "docs source missing values").toEqual([]);
  });

  test("all shared benchmark values are equal", () => {
    const mismatches: string[] = [];
    for (const [path, docsVal] of docsValues) {
      const siteVal = siteValues.get(path);
      if (siteVal === undefined) continue; // caught by previous test
      if (siteVal !== docsVal) {
        mismatches.push(`${path}: docs=${docsVal} site=${siteVal}`);
      }
    }
    if (mismatches.length > 0) {
      expect(mismatches, "differing values").toEqual([]);
    }
  });

  test(`collected ${docsValues.size} shared numeric benchmark values`, () => {
    expect(docsValues.size).toBeGreaterThan(0);
    expect(docsValues.size).toBe(siteValues.size);
  });
});
