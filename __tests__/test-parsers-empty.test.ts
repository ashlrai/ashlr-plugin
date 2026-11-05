/**
 * Unit tests for _test-parsers.ts — empty and degenerate runner output.
 *
 * Documented contract: a parser given empty output returns the zero-valued
 * TestResult — { pass: 0, fail: 0, skip: 0, durationMs: 0, failures: [] } —
 * and never throws. test-server-handlers relies on that exact shape: an
 * all-zero result is what triggers its generic-TAP fallback.
 */

import { describe, expect, test } from "bun:test";
import {
  parseJestLike,
  parseVitest,
  parseBun,
  parsePytest,
  parseGoTest,
  parseGenericTap,
  type TestResult,
} from "../servers/_test-parsers";

const EMPTY: TestResult = { pass: 0, fail: 0, skip: 0, durationMs: 0, failures: [] };

const PARSERS = [
  ["parseJestLike", (o: string) => parseJestLike(o)],
  ["parseVitest", (o: string) => parseVitest(o, "")],
  ["parseBun", (o: string) => parseBun(o, "")],
  ["parsePytest", (o: string) => parsePytest(o)],
  ["parseGoTest", (o: string) => parseGoTest(o)],
  ["parseGenericTap", (o: string) => parseGenericTap(o)],
] as const;

describe("empty output — documented zero result", () => {
  test.each(PARSERS)('%s returns the zero TestResult for ""', (_name, parse) => {
    expect(parse("")).toEqual(EMPTY);
  });

  test.each(PARSERS)("%s returns the zero TestResult for whitespace-only output", (_name, parse) => {
    for (const out of [" ", "\n", "\n\n\n", "\t\t", " \t\r\n "]) {
      expect(parse(out)).toEqual(EMPTY);
    }
  });

  test.each(PARSERS)("%s does not throw on empty output", (_name, parse) => {
    expect(() => parse("")).not.toThrow();
  });
});

describe("empty stdout/stderr combinations", () => {
  test.each([
    ["parseVitest", parseVitest],
    ["parseBun", parseBun],
  ] as const)("%s returns the zero TestResult for every empty combination", (_name, parse) => {
    for (const [stdout, stderr] of [["", ""], ["", "\n"], ["\n", ""], [" \n", " \n"]] as const) {
      expect(parse(stdout, stderr)).toEqual(EMPTY);
    }
  });
});

describe("runner noise with no test data", () => {
  // Banners, progress glyphs and "no tests" lines a runner may emit when it
  // finds nothing to run. None carry counts or failure markers, so the
  // documented result is still the zero TestResult.
  const NOISE = [
    "bun test v1.1.0",
    "[bun test] No test files found.",
    "TAP version 13\n1..0",
    "?  \texample.com/pkg\t[no test files]",
    "\x1b[32m\x1b[39m",
    "============================= test session starts ==============================\n" +
      "platform darwin -- Python 3.12.0\n" +
      "rootdir: /tmp/x\n" +
      "collected 0 items",
  ];

  test.each(PARSERS)("%s still returns the zero TestResult", (_name, parse) => {
    for (const out of NOISE) {
      expect(parse(out)).toEqual(EMPTY);
    }
  });
});

describe("result object invariants", () => {
  test.each(PARSERS)("%s returns a fresh result on every call", (_name, parse) => {
    const a = parse("");
    const b = parse("");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.failures).not.toBe(b.failures);
  });

  test("mutating one result does not leak into later parses", () => {
    const a = parseBun("", "");
    a.failures.push({ file: "x.test.ts", testName: "y", message: "z", stack: [] });
    expect(parseBun("", "")).toEqual(EMPTY);
  });
});

// Boundary case: "empty" means the runner printed nothing. A pytest banner
// that reports a duration still yields zero counts — the parser keeps the
// timing it can see — while producing no failure records.
describe("no-tests-ran boundary", () => {
  test("pytest 'no tests ran' summary — zero counts, duration still captured", () => {
    const r = parsePytest("======= no tests ran in 0.01s =======");
    expect(r).toEqual({ pass: 0, fail: 0, skip: 0, durationMs: 10, failures: [] });
  });
});
