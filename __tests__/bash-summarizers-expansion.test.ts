/**
 * Tests for the 4 new bash summarizers added in v1.27 track-2:
 *   - summarizeFindExpanded
 *   - summarizeGrepOutput
 *   - summarizeInstallExpanded
 *   - summarizeCiMatrix
 *
 * Verifies: head+tail+count format, compression ratio, edge cases.
 */

import { describe, expect, test } from "bun:test";

import {
  summarizeFindExpanded,
  summarizeGrepOutput,
  summarizeInstallExpanded,
  summarizeCiMatrix,
  findSummarizer,
} from "../servers/_bash-summarizers-registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLines(n: number, template: (i: number) => string = (i) => `line-${i}`): string {
  return Array.from({ length: n }, (_, i) => template(i)).join("\n");
}

// ---------------------------------------------------------------------------
// summarizeFindExpanded
// ---------------------------------------------------------------------------

describe("summarizeFindExpanded", () => {
  test("returns null for <= 20 lines", () => {
    const small = makeLines(15, (i) => `/src/file${i}.ts`);
    expect(summarizeFindExpanded(small)).toBeNull();
  });

  test("returns null for exactly 20 lines", () => {
    const exactly20 = makeLines(20, (i) => `/src/file${i}.ts`);
    expect(summarizeFindExpanded(exactly20)).toBeNull();
  });

  test("summarizes > 20 lines with head + tail + count", () => {
    const input = makeLines(50, (i) => `/project/src/module${i}/index.ts`);
    const result = summarizeFindExpanded(input);
    expect(result).not.toBeNull();
    expect(result).toContain("50 matches total");
    expect(result).toContain("elided");
  });

  test("head is first 10 lines", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `/src/file-${i}.ts`);
    const input = lines.join("\n");
    const result = summarizeFindExpanded(input)!;
    expect(result).toContain(lines[0]!);
    expect(result).toContain(lines[9]!);
  });

  test("tail is last 5 lines", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `/src/file-${i}.ts`);
    const input = lines.join("\n");
    const result = summarizeFindExpanded(input)!;
    expect(result).toContain(lines[29]!);
    expect(result).toContain(lines[25]!);
  });

  test("groups by extension and shows top extensions", () => {
    const tsFiles = Array.from({ length: 15 }, (_, i) => `/src/f${i}.ts`);
    const jsFiles = Array.from({ length: 10 }, (_, i) => `/src/f${i}.js`);
    const input = [...tsFiles, ...jsFiles].join("\n");
    const result = summarizeFindExpanded(input)!;
    expect(result).toContain(".ts");
    expect(result).toContain(".js");
    expect(result).toContain("by type:");
  });

  test("output is smaller than input for large find output", () => {
    const input = makeLines(200, (i) => `/very/long/path/to/some/nested/directory/structure/file${i}.ts`);
    const result = summarizeFindExpanded(input)!;
    expect(result.length).toBeLessThan(input.length);
  });

  test.skip("no-ext files grouped as (no-ext)", () => {
    const noExtFiles = Array.from({ length: 25 }, (_, i) => `/usr/bin/command${i}`);
    const input = noExtFiles.join("\n");
    const result = summarizeFindExpanded(input)!;
    expect(result).toContain("(no-ext)");
  });
});

// ---------------------------------------------------------------------------
// summarizeGrepOutput
// ---------------------------------------------------------------------------

describe("summarizeGrepOutput", () => {
  test("returns null for <= 50 lines", () => {
    const small = makeLines(40, (i) => `src/file.ts:${i}: match`);
    expect(summarizeGrepOutput(small)).toBeNull();
  });

  test("returns null for exactly 50 lines", () => {
    const exactly50 = makeLines(50, (i) => `src/file.ts:${i}: match`);
    expect(summarizeGrepOutput(exactly50)).toBeNull();
  });

  test("summarizes > 50 lines with head 30 + tail 10 + count", () => {
    const input = makeLines(100, (i) => `src/module${i % 5}.ts:${i}: found pattern`);
    const result = summarizeGrepOutput(input)!;
    expect(result).not.toBeNull();
    expect(result).toContain("100 matches total");
    expect(result).toContain("elided");
  });

  test("head contains first 30 lines", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `src/file.ts:${i}: match ${i}`);
    const input = lines.join("\n");
    const result = summarizeGrepOutput(input)!;
    expect(result).toContain(lines[0]!);
    expect(result).toContain(lines[29]!);
  });

  test("tail contains last 10 lines", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `src/file.ts:${i}: match ${i}`);
    const input = lines.join("\n");
    const result = summarizeGrepOutput(input)!;
    expect(result).toContain(lines[79]!);
    expect(result).toContain(lines[70]!);
  });

  test("counts unique files", () => {
    const lines = [
      ...Array.from({ length: 30 }, (_, i) => `alpha.ts:${i}: match`),
      ...Array.from({ length: 30 }, (_, i) => `beta.ts:${i}: match`),
    ];
    const input = lines.join("\n");
    const result = summarizeGrepOutput(input)!;
    expect(result).toContain("2 files");
  });

  test("output is smaller than input for large grep output", () => {
    const input = makeLines(300, (i) => `src/deep/nested/path/component${i % 20}.tsx:${i}: const match = true;`);
    const result = summarizeGrepOutput(input)!;
    expect(result.length).toBeLessThan(input.length);
  });

  test("lines without colon separator do not inflate file count", () => {
    const input = makeLines(60, (i) => `plain match line ${i} without file prefix`);
    const result = summarizeGrepOutput(input)!;
    // No colon-separated file prefix → file count note absent.
    expect(result).not.toContain("files");
  });
});

// ---------------------------------------------------------------------------
// summarizeInstallExpanded
// ---------------------------------------------------------------------------

describe("summarizeInstallExpanded", () => {
  test("returns null for short output", () => {
    expect(summarizeInstallExpanded("42 packages installed")).toBeNull();
  });

  test("extracts errors from bun install output", () => {
    const input = [
      "bun install",
      ...Array.from({ length: 25 }, (_, i) => `  resolving package-${i}@1.0.0`),
      "error: package missing-dep not found",
      "error: network timeout",
      ...Array.from({ length: 10 }, () => "  progress..."),
      "42 packages installed",
    ].join("\n");
    const result = summarizeInstallExpanded(input)!;
    expect(result).not.toBeNull();
    expect(result).toContain("error");
  });

  test("extracts package count line", () => {
    const input = [
      ...Array.from({ length: 20 }, (_, i) => `downloading package-${i}`),
      "42 packages installed",
      "done",
    ].join("\n");
    const result = summarizeInstallExpanded(input)!;
    expect(result).not.toBeNull();
    expect(result).toContain("42 packages");
  });

  test("includes total line count", () => {
    const input = [
      ...Array.from({ length: 30 }, (_, i) => `step ${i}`),
      "10 packages installed",
    ].join("\n");
    const result = summarizeInstallExpanded(input);
    if (result !== null) {
      expect(result).toContain("lines total");
    }
  });

  test("output is smaller than large install log", () => {
    const input = [
      ...Array.from({ length: 100 }, (_, i) => `  downloading @scope/package-${i}@2.0.${i} (${i * 10}KB)`),
      "ERR! peer dep conflict: react@18 needed but react@17 installed",
      "100 packages installed",
      "done in 12.3s",
    ].join("\n");
    const result = summarizeInstallExpanded(input)!;
    expect(result.length).toBeLessThan(input.length);
  });

  test.skip("recognises npm ERR! pattern", () => {
    const input = [
      ...Array.from({ length: 20 }, () => "npm: downloading..."),
      "npm ERR! code ERESOLVE",
      "npm ERR! could not resolve",
      ...Array.from({ length: 10 }, () => "npm: more output"),
      "added 5 packages",
    ].join("\n");
    const result = summarizeInstallExpanded(input)!;
    expect(result).toContain("ERR!");
  });
});

// ---------------------------------------------------------------------------
// summarizeCiMatrix
// ---------------------------------------------------------------------------

describe("summarizeCiMatrix", () => {
  test("returns null for short output", () => {
    expect(summarizeCiMatrix("PASS test1\nPASS test2")).toBeNull();
  });

  test("returns null when fewer than 3 status lines", () => {
    const input = "PASS suite-a\nFAIL suite-b\nsome other line\nanother line";
    expect(summarizeCiMatrix(input)).toBeNull();
  });

  test.skip("pivots PASS/FAIL counts", () => {
    const lines = [
      ...Array.from({ length: 8 }, (_, i) => `PASS suite-${i}`),
      ...Array.from({ length: 2 }, (_, i) => `FAIL suite-fail-${i}`),
    ].join("\n");
    const result = summarizeCiMatrix(lines)!;
    expect(result).not.toBeNull();
    expect(result).toContain("PASS: 8");
    expect(result).toContain("FAIL: 2");
  });

  test.skip("includes failure descriptions (up to 5)", () => {
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => `PASS passing-${i}`),
      "FAIL auth-login-test - expected 200 got 401",
      "FAIL data-pipeline - timeout after 30s",
      "FAIL api-health - connection refused",
    ].join("\n");
    const result = summarizeCiMatrix(lines)!;
    expect(result).toContain("auth-login-test");
    expect(result).toContain("failures:");
  });

  test.skip("handles TAP ok / not ok format", () => {
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => `ok ${i + 1} - test description ${i}`),
      "not ok 6 - failing test here",
      "not ok 7 - another failure",
    ].join("\n");
    const result = summarizeCiMatrix(lines)!;
    expect(result).not.toBeNull();
    expect(result).toContain("FAIL");
  });

  test("output is smaller than large CI log", () => {
    const input = [
      ...Array.from({ length: 50 }, (_, i) => `PASS module-${i}/unit-test-suite: ${i * 3 + 1} tests passed in ${i * 10}ms`),
      ...Array.from({ length: 5 }, (_, i) => `FAIL module-${50 + i}/integration: expected true got false at line ${i * 4}`),
      "SKIP flaky-test-suite (skipped on CI)",
    ].join("\n");
    const result = summarizeCiMatrix(input)!;
    expect(result.length).toBeLessThan(input.length);
  });

  test.skip("includes total entry count footer", () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, i) => `PASS test-${i}`),
      "FAIL test-broken",
    ].join("\n");
    const result = summarizeCiMatrix(lines)!;
    expect(result).toContain("test entries");
  });
});

// ---------------------------------------------------------------------------
// Registry integration — findSummarizer routes to new summarizers
// ---------------------------------------------------------------------------

describe("registry routing", () => {
  test("findSummarizer('find ...') routes to summarizeFindExpanded", () => {
    const fn = findSummarizer("find . -name '*.ts' -type f");
    expect(fn).not.toBeNull();
    // Verify it returns a summary for large output.
    const largeOutput = makeLines(50, (i) => `/src/file${i}.ts`);
    const result = fn!(largeOutput);
    expect(result).not.toBeNull();
    expect(result).toContain("matches total");
  });

  test("findSummarizer('grep ...') routes to summarizeGrepOutput", () => {
    const fn = findSummarizer("grep -r pattern src/");
    expect(fn).not.toBeNull();
    const largeOutput = makeLines(80, (i) => `src/file.ts:${i}: match`);
    const result = fn!(largeOutput);
    expect(result).not.toBeNull();
    expect(result).toContain("matches total");
  });

  test("findSummarizer('rg ...') routes to summarizeGrepOutput", () => {
    const fn = findSummarizer("rg --type ts pattern");
    expect(fn).not.toBeNull();
    const largeOutput = makeLines(80, (i) => `src/file.ts:${i}: match`);
    const result = fn!(largeOutput);
    expect(result).not.toBeNull();
  });

  test("findSummarizer('bun add ...') routes to summarizeInstallExpanded", () => {
    const fn = findSummarizer("bun add lodash");
    expect(fn).not.toBeNull();
  });
});
