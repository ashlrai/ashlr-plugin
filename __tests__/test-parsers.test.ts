/**
 * Unit tests for _test-parsers.ts
 *
 * One fixture per runner covering: all-pass, mixed pass+fail, edge cases.
 */

import { describe, expect, test } from "bun:test";
import {
  parseJestLike,
  parseVitest,
  parseBun,
  parsePytest,
  parseGoTest,
  parseGenericTap,
} from "../servers/_test-parsers";

// ---------------------------------------------------------------------------
// Jest-like (bun test / Jest / Vitest)
// ---------------------------------------------------------------------------

describe("parseJestLike", () => {
  test("bun test — all passed", () => {
    const output = `
bun test v1.1.0

 src/math.test.ts:
   ✓ adds two numbers (2ms)
   ✓ subtracts two numbers (1ms)

2 pass · 0 fail · 0 skip · in 45ms
`;
    const r = parseJestLike(output);
    expect(r.pass).toBe(2);
    expect(r.fail).toBe(0);
    expect(r.skip).toBe(0);
    expect(r.failures).toHaveLength(0);
  });

  test("bun test — mixed pass + fail", () => {
    const output = `
bun test v1.1.0

 src/foo.test.ts:
   ✓ handles normal case (1ms)
   ✗ handles empty array (2ms)

  ✗ src/foo.test.ts:42 > handles empty array
    AssertionError: expected [] to equal [1]
      at Object.<anonymous> (src/foo.test.ts:42:15)

1 pass · 1 fail · 0 skip · in 55ms
`;
    const r = parseJestLike(output);
    expect(r.pass).toBe(1);
    expect(r.fail).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].testName).toContain("handles empty array");
    expect(r.failures[0].message).toBeTruthy();
    expect(r.durationMs).toBe(55);
  });

  test("Jest — summary line format", () => {
    const output = `
FAIL src/bar.test.ts
  ✕ rejects negative

Tests: 1 failed, 5 passed, 1 skipped, 7 total
Time: 2.3s
`;
    const r = parseJestLike(output);
    expect(r.fail).toBe(1);
    expect(r.pass).toBe(5);
    expect(r.skip).toBe(1);
    expect(r.durationMs).toBe(2300);
  });

  test("Vitest — summary line format", () => {
    const output = `
 FAIL  src/baz.test.ts

  ✗ rejects invalid input

  ✗ src/baz.test.ts:18 > rejects invalid input
    TypeError: Cannot read properties of undefined
      at validator (src/baz.ts:7:23)
      at Object.<anonymous> (src/baz.test.ts:18:11)

Test Files  1 failed (1)
Tests  1 failed | 10 passed (11)
Duration  1.23s
`;
    const r = parseJestLike(output);
    expect(r.fail).toBeGreaterThanOrEqual(1);
    expect(r.failures.length).toBeGreaterThanOrEqual(1);
  });

  test("no tests found — zero counts", () => {
    const output = "[bun test] No test files found.";
    const r = parseJestLike(output);
    expect(r.pass).toBe(0);
    expect(r.fail).toBe(0);
    expect(r.failures).toHaveLength(0);
  });

  test("all passed — no failure blocks", () => {
    const output = `
10 pass · 0 fail · 2 skip · in 1.2s
`;
    const r = parseJestLike(output);
    expect(r.pass).toBe(10);
    expect(r.fail).toBe(0);
    expect(r.skip).toBe(2);
    expect(r.failures).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pytest
// ---------------------------------------------------------------------------

describe("parsePytest", () => {
  test("all passed", () => {
    const output = `
collected 5 items

.....

======= 5 passed in 0.42s =======
`;
    const r = parsePytest(output);
    expect(r.pass).toBe(5);
    expect(r.fail).toBe(0);
    expect(r.durationMs).toBe(420);
  });

  test("mixed pass + fail with short traceback", () => {
    const output = `
collected 4 items

..FF

======= FAILURES =======
__________________ test_divide_by_zero __________________

    def test_divide_by_zero():
>       result = divide(10, 0)

tests/test_math.py:15
E   ZeroDivisionError: division by zero

FAILED tests/test_math.py::test_divide_by_zero - ZeroDivisionError: division by zero
FAILED tests/test_math.py::test_negative - AssertionError: assert -1 == 1

======= 2 failed, 2 passed in 1.23s =======
`;
    const r = parsePytest(output);
    expect(r.fail).toBe(2);
    expect(r.pass).toBe(2);
    expect(r.durationMs).toBe(1230);
    expect(r.failures.length).toBeGreaterThanOrEqual(1);
  });

  test("no tests collected", () => {
    const output = "======= no tests ran in 0.01s =======";
    const r = parsePytest(output);
    expect(r.pass).toBe(0);
    expect(r.fail).toBe(0);
  });

  test("FAILED line parses file + testName", () => {
    const output = `
FAILED tests/test_foo.py::test_bar - AssertionError: nope

======= 1 failed in 0.5s =======
`;
    const r = parsePytest(output);
    expect(r.failures[0].file).toBe("tests/test_foo.py");
    expect(r.failures[0].testName).toBe("test_bar");
    expect(r.failures[0].message).toContain("AssertionError");
  });
});

// ---------------------------------------------------------------------------
// go test
// ---------------------------------------------------------------------------

describe("parseGoTest", () => {
  test("JSON mode — all passed", () => {
    const output = [
      JSON.stringify({ Action: "run", Test: "TestAdd" }),
      JSON.stringify({ Action: "pass", Test: "TestAdd", Elapsed: 0.001 }),
      JSON.stringify({ Action: "pass", Elapsed: 0.5 }),
    ].join("\n");
    const r = parseGoTest(output);
    expect(r.pass).toBe(1);
    expect(r.fail).toBe(0);
    expect(r.durationMs).toBe(500);
  });

  test("JSON mode — one failure", () => {
    const output = [
      JSON.stringify({ Action: "run", Test: "TestBad" }),
      JSON.stringify({ Action: "output", Test: "TestBad", Output: "--- FAIL: TestBad (0.00s)\n" }),
      JSON.stringify({ Action: "output", Test: "TestBad", Output: "    math_test.go:22: expected 1, got 0\n" }),
      JSON.stringify({ Action: "fail", Test: "TestBad", Elapsed: 0.002 }),
      JSON.stringify({ Action: "fail", Elapsed: 0.1 }),
    ].join("\n");
    const r = parseGoTest(output);
    expect(r.fail).toBe(1);
    expect(r.failures[0].testName).toBe("TestBad");
  });

  test("plain mode — mixed", () => {
    const output = `
--- PASS: TestAdd (0.00s)
--- FAIL: TestSubtract (0.00s)
    math_test.go:30: expected -1, got 1
--- PASS: TestMultiply (0.00s)
ok  	example.com/math	0.050s
`;
    const r = parseGoTest(output);
    expect(r.pass).toBe(2);
    expect(r.fail).toBe(1);
    expect(r.failures[0].testName).toBe("TestSubtract");
    expect(r.durationMs).toBe(50);
  });

  test("plain mode — all pass", () => {
    const output = `
--- PASS: TestA (0.00s)
--- PASS: TestB (0.00s)
ok  	example.com/pkg	0.020s
`;
    const r = parseGoTest(output);
    expect(r.pass).toBe(2);
    expect(r.fail).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Generic TAP fallback
// ---------------------------------------------------------------------------

describe("parseGenericTap", () => {
  test("TAP ok/not ok lines", () => {
    const output = `
TAP version 13
ok 1 - first test
ok 2 - second test
not ok 3 - third test
# AssertionError: expected true but got false
ok 4 - fourth test
`;
    const r = parseGenericTap(output);
    expect(r.pass).toBe(3);
    expect(r.fail).toBe(1);
    expect(r.failures[0].testName).toContain("third test");
    expect(r.failures[0].message).toContain("AssertionError");
  });

  test("PASSED/FAILED keyword lines", () => {
    const output = `
test_alpha PASSED
test_beta FAILED
test_gamma PASSED
`;
    const r = parseGenericTap(output);
    expect(r.pass).toBeGreaterThanOrEqual(2);
    expect(r.fail).toBeGreaterThanOrEqual(1);
  });

  test("empty / no tests", () => {
    const r = parseGenericTap("");
    expect(r.pass).toBe(0);
    expect(r.fail).toBe(0);
    expect(r.failures).toHaveLength(0);
  });

  test("truncated output — partial parse", () => {
    const output = `
ok 1 - passes
not ok 2 - fails
# Error: timeout
`; // truncated — no summary line
    const r = parseGenericTap(output);
    expect(r.fail).toBe(1);
    expect(r.failures[0].message).toContain("timeout");
  });
});

// ---------------------------------------------------------------------------
// parseVitest
// ---------------------------------------------------------------------------

describe("parseVitest", () => {
  test("all passed — summary lines only", () => {
    const stdout = `
 DEV  v1.4.0 /project

 ✓ src/math.test.ts (10)

Test Files  1 passed (1)
Tests  10 passed (10)
Duration  1.23s
`;
    const r = parseVitest(stdout, "");
    expect(r.pass).toBe(10);
    expect(r.fail).toBe(0);
    expect(r.skip).toBe(0);
    expect(r.durationMs).toBe(1230);
    expect(r.failures).toHaveLength(0);
  });

  test("mixed pass+fail — FAIL header + inline ✗", () => {
    const stdout = `
 FAIL  src/validator.test.ts

 — Failed Tests 1 ——

 FAIL  src/validator.test.ts > validateEmail > rejects invalid email
 AssertionError: expected false to be true
  at src/validator.test.ts:18:18

Test Files  1 failed | 1 passed (2)
Tests  1 failed | 5 passed (6)
Duration  245ms
`;
    const r = parseVitest(stdout, "");
    expect(r.fail).toBe(1);
    expect(r.pass).toBe(5);
    expect(r.durationMs).toBe(245);
  });

  test("❯ chained file:line > testName form parses failure", () => {
    const stdout = `
❯ src/foo.test.ts:42 > suite name > test name
  AssertionError: expected 1 but received 0
    at foo.test.ts:42:5

Tests  1 failed | 3 passed (4)
Duration  90ms
`;
    const r = parseVitest(stdout, "");
    expect(r.fail).toBeGreaterThanOrEqual(1);
    expect(r.failures.length).toBeGreaterThanOrEqual(1);
    expect(r.failures[0]?.file).toBe("src/foo.test.ts");
    expect(r.failures[0]?.line).toBe(42);
    expect(r.failures[0]?.testName).toContain("test name");
    expect(r.failures[0]?.message).toContain("AssertionError");
  });

  test("no tests — zero counts", () => {
    const r = parseVitest("No test files found.", "");
    expect(r.pass).toBe(0);
    expect(r.fail).toBe(0);
    expect(r.failures).toHaveLength(0);
  });

  test("duration in ms format", () => {
    const r = parseVitest("Tests  2 passed (2)\nDuration  245ms", "");
    expect(r.durationMs).toBe(245);
  });

  test("skipped tests counted", () => {
    const r = parseVitest("Tests  1 failed | 3 passed | 2 skipped (6)\nDuration  1s", "");
    expect(r.fail).toBe(1);
    expect(r.pass).toBe(3);
    expect(r.skip).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// parseBun
// ---------------------------------------------------------------------------

describe("parseBun", () => {
  test("all passed — summary line", () => {
    const stdout = `
bun test v1.1.0

 src/math.test.ts:
   ✓ adds numbers (2ms)
   ✓ subtracts numbers (1ms)

2 pass · 0 fail · 0 skip · in 34ms
`;
    const r = parseBun(stdout, "");
    expect(r.pass).toBe(2);
    expect(r.fail).toBe(0);
    expect(r.skip).toBe(0);
    expect(r.durationMs).toBe(34);
    expect(r.failures).toHaveLength(0);
  });

  test("mixed pass+fail — detail block with file:line > testName", () => {
    const stdout = `
bun test v1.1.0

 src/foo.test.ts:
   ✓ handles normal case (1ms)
   ✗ handles empty array (2ms)

  ✗ src/foo.test.ts:42 > handles empty array
    AssertionError: expected [] to equal [1]
      at Object.<anonymous> (src/foo.test.ts:42:15)

1 pass · 1 fail · 0 skip · in 55ms
`;
    const r = parseBun(stdout, "");
    expect(r.pass).toBe(1);
    expect(r.fail).toBe(1);
    expect(r.durationMs).toBe(55);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]?.file).toBe("src/foo.test.ts");
    expect(r.failures[0]?.line).toBe(42);
    expect(r.failures[0]?.testName).toContain("handles empty array");
    expect(r.failures[0]?.message).toContain("AssertionError");
  });

  test("skipped tests counted", () => {
    const r = parseBun("3 pass · 1 fail · 2 skip · in 100ms", "");
    expect(r.pass).toBe(3);
    expect(r.fail).toBe(1);
    expect(r.skip).toBe(2);
    expect(r.durationMs).toBe(100);
  });

  test("no tests found — zero counts", () => {
    const r = parseBun("[bun test] No test files found.", "");
    expect(r.pass).toBe(0);
    expect(r.fail).toBe(0);
    expect(r.failures).toHaveLength(0);
  });

  test("multiple failures — all captured", () => {
    const stdout = `
  ✗ src/a.test.ts:10 > first fail
    TypeError: Cannot read property
      at Object.<anonymous> (src/a.test.ts:10:5)
  ✗ src/b.test.ts:20 > second fail
    RangeError: out of bounds
      at Object.<anonymous> (src/b.test.ts:20:3)

0 pass · 2 fail · 0 skip · in 22ms
`;
    const r = parseBun(stdout, "");
    expect(r.fail).toBe(2);
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]?.file).toBe("src/a.test.ts");
    expect(r.failures[1]?.file).toBe("src/b.test.ts");
  });

  test("duration in seconds format", () => {
    const r = parseBun("5 pass · 0 fail · 0 skip · in 1.2s", "");
    expect(r.durationMs).toBe(1200);
  });

  test("stderr combined with stdout for failure detection", () => {
    const stdout = "0 pass · 1 fail · 0 skip · in 10ms";
    const stderr = "  ✗ src/x.test.ts:5 > error test\n    Error: something went wrong";
    const r = parseBun(stdout, stderr);
    expect(r.fail).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]?.file).toBe("src/x.test.ts");
  });
});
