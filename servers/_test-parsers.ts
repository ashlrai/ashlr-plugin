/**
 * _test-parsers — structured parsers for common test runner output.
 *
 * Each parser converts raw stdout+stderr into a TestResult with pass/fail/skip
 * counts, duration, and per-failure details. Used by test-server-handlers.ts.
 */

export interface TestFailure {
  file: string;
  line?: number;
  testName: string;
  message: string;
  stack: string[];
}

export interface TestResult {
  pass: number;
  fail: number;
  skip: number;
  durationMs: number;
  failures: TestFailure[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMs(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  if (s.includes("ms")) return n;
  if (s.includes("s")) return Math.round(n * 1000);
  return n;
}

// ---------------------------------------------------------------------------
// Jest-like (Jest, Vitest, bun test) — share same PASS/FAIL output format
// ---------------------------------------------------------------------------

export function parseJestLike(output: string): TestResult {
  const lines = output.split("\n");
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let durationMs = 0;
  const failures: TestFailure[] = [];

  // Summary line patterns:
  // "Tests: 3 failed, 10 passed, 2 skipped, 15 total"  (Jest)
  // "✓ 10 | ✗ 3 | ↓ 2"                                (Vitest)
  // "47 pass · 3 fail · 0 skip"                        (bun test)
  const summaryJest = /Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+passed,?\s*)?(?:(\d+)\s+skipped)?/.exec(output);
  const summaryBun = /(\d+)\s+pass(?:ed)?\s*[·,]\s*(\d+)\s+fail(?:ed)?\s*[·,]?\s*(\d+)?\s*skip/.exec(output);
  const summaryVitest = /(\d+)\s+passed.*?(\d+)\s+failed/.exec(output);

  if (summaryBun) {
    pass = parseInt(summaryBun[1] ?? "0", 10);
    fail = parseInt(summaryBun[2] ?? "0", 10);
    skip = parseInt(summaryBun[3] ?? "0", 10);
  } else if (summaryJest) {
    fail = parseInt(summaryJest[1] ?? "0", 10);
    pass = parseInt(summaryJest[2] ?? "0", 10);
    skip = parseInt(summaryJest[3] ?? "0", 10);
  } else if (summaryVitest) {
    pass = parseInt(summaryVitest[1] ?? "0", 10);
    fail = parseInt(summaryVitest[2] ?? "0", 10);
  }

  // Duration: "Time: 5.2s" · "Duration 1.23s" · "ran in 0.4ms" · bun's
  // "in 55ms" at the tail of "N pass · M fail · K skip · in 55ms".
  const dur = /(?:Time|Duration|ran in|\bin)[:\s]+(\d+(?:\.\d+)?(?:ms|s))\b/.exec(output);
  if (dur) durationMs = parseMs(dur[1]);

  // Parse per-failure blocks.
  // Jest/Vitest/bun emit:
  //   ● test suite › test name        (Jest)
  //   ✗ src/foo.test.ts:42 > test name (bun / Vitest)
  //   FAIL src/bar.test.ts
  //     ✕ test name
  //
  // Strategy: find failure header lines, then slurp following indented lines.
  // Only match leading-whitespace lines (not deeply nested stack frames)
  const failHeaderRe = /^[ \t]{0,4}(?:●|✗|✕|×)\s+(.+?)(?:\s*[>›]\s*(.+?))?$/;
  const fileLineRe = /^(.*?\.(?:test|spec)\.[jt]sx?):(\d+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hm = failHeaderRe.exec(line);
    if (!hm) continue;

    // hm[1] may be "file:line > testName" or just "suite › testName"
    let file = "";
    let lineNo: number | undefined;
    let testName = (hm[2] ?? hm[1]).trim();

    const flm = fileLineRe.exec(hm[1]);
    if (flm) {
      file = flm[1];
      lineNo = parseInt(flm[2], 10);
      // testName may be in hm[2] or after the > separator
      if (hm[2]) testName = hm[2].trim();
    } else {
      // Bun test emits a brief list item like "   ✗ handles empty array (2ms)"
      // alongside a detailed failure block further down. Only the detailed
      // form carries a file path; the brief list is reporting, not a failure
      // record. Skip it so we don't double-count.
      continue;
    }

    // Collect indented body lines (message + stack)
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && (lines[j].startsWith("  ") || lines[j].startsWith("\t") || lines[j].trim() === "")) {
      const trimmed = lines[j].trim();
      if (trimmed) body.push(trimmed);
      j++;
    }

    const message = body[0] ?? "";
    const stack = body.slice(1).filter((l) => l.startsWith("at ") || l.includes(".ts:") || l.includes(".js:"));

    failures.push({ file, line: lineNo, testName, message, stack });
  }

  // If summary didn't parse counts but we found failures, use those
  if (fail === 0 && failures.length > 0) fail = failures.length;

  return { pass, fail, skip, durationMs, failures };
}


// ---------------------------------------------------------------------------
// Vitest — distinct format from Jest: "Test Files  N passed", "Tests  N passed | M failed",
// file paths with ❯ cursor character, colon-prefixed line numbers.
// ---------------------------------------------------------------------------

/**
 * Parse Vitest output (bunx vitest --run / npx vitest run).
 *
 * Key differences from Jest:
 *   - Summary uses "Tests  N failed | M passed" lines (not Jest-style)
 *   - Failure headers use ❯ or "FAIL  <path>" followed by ✗/× failure names
 *   - Duration appears as "Duration  1.23s" or "Duration  245ms"
 */
export function parseVitest(stdout: string, stderr: string): TestResult {
  const output = stdout + "\n" + stderr;
  const lines = output.split("\n");
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let durationMs = 0;
  const failures: TestFailure[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // "Tests  1 failed | 10 passed (11)"  or  "Tests  5 passed (5)"
    const testsLine = /^Tests\s+(.+)$/.exec(trimmed);
    if (testsLine) {
      const body = testsLine[1]!;
      const fm = /(\d+)\s+failed/.exec(body); if (fm) fail = parseInt(fm[1]!, 10);
      const pm = /(\d+)\s+passed/.exec(body); if (pm) pass = parseInt(pm[1]!, 10);
      const sm = /(\d+)\s+skipped/.exec(body); if (sm) skip = parseInt(sm[1]!, 10);
      continue;
    }

    // "Duration  1.23s" or "Duration  245ms"
    const durLine = /^Duration\s+(\d+(?:\.\d+)?(?:ms|s))/.exec(trimmed);
    if (durLine) { durationMs = parseMs(durLine[1]!); continue; }
  }

  // Failure blocks — two shapes:
  // Shape A: "❯ src/foo.test.ts:42 > testName" (chained path with file reference)
  // Shape B: "FAIL  src/foo.test.ts" then indented "✗ test name" lines
  const chainedRe = /^[ 	]*❯\s+([\w./\-]+\.(?:test|spec)\.[jt]sx?):(\d+)(?:\s*>\s*(.+))?$/;
  const inlineFailRe = /^[ 	]{2,}(?:✗|×|✕|●)\s+(.+?)(?:\s*\(\d+(?:\.\d+)?ms\))?$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Shape A — ❯ file:line > testName
    const cm = chainedRe.exec(line);
    if (cm) {
      const file = cm[1]!;
      const lineNo = parseInt(cm[2]!, 10);
      const testName = cm[3]?.trim() ?? "";
      if (testName) {
        const body: string[] = [];
        let j = i + 1;
        while (j < lines.length && (lines[j]!.startsWith("  ") || lines[j]!.startsWith("	"))) {
          const t = lines[j]!.trim();
          if (t) body.push(t);
          j++;
        }
        const message = body.find((l) => !l.startsWith("at ") && !l.includes(".ts:") && !l.includes(".js:")) ?? "";
        const stack = body.filter((l) => l.startsWith("at ") || l.includes(".ts:") || l.includes(".js:"));
        failures.push({ file, line: lineNo, testName, message, stack });
      }
      continue;
    }

    // Shape B — "FAIL  src/foo.test.ts" header
    if (/^[ 	]*FAIL\s+[\w./]/.test(line)) {
      const fileMatch = /FAIL\s+([\w./\-]+\.(?:test|spec)\.[jt]sx?)(?::(\d+))?/.exec(line);
      if (!fileMatch) continue;
      const file = fileMatch[1]!;
      const fileLineNo = fileMatch[2] ? parseInt(fileMatch[2], 10) : undefined;
      let j = i + 1;
      while (j < lines.length) {
        const inner = lines[j]!;
        if (/^(?:FAIL|PASS|Test Files|Tests|Duration)/.test(inner.trim()) && inner.trim().length > 3) break;
        const im = inlineFailRe.exec(inner);
        if (im) {
          const testName = im[1]!.trim();
          const body: string[] = [];
          let k = j + 1;
          while (k < lines.length && (lines[k]!.startsWith("    ") || lines[k]!.startsWith("		"))) {
            const t = lines[k]!.trim();
            if (t) body.push(t);
            k++;
          }
          const message = body.find((l) => !l.startsWith("at ") && !l.includes(".ts:")) ?? "";
          const stack = body.filter((l) => l.startsWith("at ") || l.includes(".ts:"));
          failures.push({ file, line: fileLineNo, testName, message, stack });
        }
        j++;
      }
      continue;
    }
  }

  if (fail === 0 && failures.length > 0) fail = failures.length;

  return { pass, fail, skip, durationMs, failures };
}

// ---------------------------------------------------------------------------
// bun:test — "✓" / "✗" glyphs at start of lines, "(Xms)" timing suffix,
// "N pass · N skip · N fail" summary line.
// ---------------------------------------------------------------------------

/**
 * Parse bun:test output (bun test / bunx jest).
 *
 * Key differences from Jest:
 *   - Summary: "N pass · M fail · K skip · in Xms" (middot · separator)
 *   - Failure detail: "✗ src/foo.test.ts:42 > test name" then indented message
 */
export function parseBun(stdout: string, stderr: string): TestResult {
  const output = stdout + "\n" + stderr;
  const lines = output.split("\n");
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let durationMs = 0;
  const failures: TestFailure[] = [];

  // Summary: "N pass · M fail · K skip · in Xms"
  const summaryRe = /(\d+)\s+pass(?:ed)?\s*[·|,]\s*(\d+)\s+fail(?:ed)?(?:\s*[·|,]\s*(\d+)\s*skip)?/i;
  const sm = summaryRe.exec(output);
  if (sm) {
    pass = parseInt(sm[1]!, 10);
    fail = parseInt(sm[2]!, 10);
    skip = parseInt(sm[3] ?? "0", 10);
  }

  // Duration from tail of summary: "in 55ms" or "in 1.2s"
  const dur = /in\s+(\d+(?:\.\d+)?(?:ms|s))/.exec(output);
  if (dur) durationMs = parseMs(dur[1]!);

  // Failure detail blocks:
  //   ✗ src/foo.test.ts:42 > test name
  //     AssertionError: expected [] to equal [1]
  //       at Object.<anonymous> (src/foo.test.ts:42:15)
  const failDetailRe = /^[ 	]{0,4}✗\s+([\w./\-]+\.(?:test|spec)\.[jt]sx?):(\d+)(?:\s*>\s*(.+))?$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fm = failDetailRe.exec(line);
    if (!fm) continue;

    const file = fm[1]!;
    const lineNo = parseInt(fm[2]!, 10);
    const testName = fm[3]?.trim() ?? "";

    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && (lines[j]!.startsWith("  ") || lines[j]!.startsWith("	"))) {
      const t = lines[j]!.trim().replace(/\s*\(\d+(?:\.\d+)?ms\)\s*$/, "");
      if (t) body.push(t);
      j++;
    }

    const message = body.find((l) => !l.startsWith("at ") && !l.includes(".ts:") && !l.includes(".js:")) ?? "";
    const stack = body.filter((l) => l.startsWith("at ") || l.includes(".ts:") || l.includes(".js:"));

    failures.push({ file, line: lineNo, testName, message, stack });
  }

  if (fail === 0 && failures.length > 0) fail = failures.length;

  return { pass, fail, skip, durationMs, failures };
}

// ---------------------------------------------------------------------------
// pytest
// ---------------------------------------------------------------------------

export function parsePytest(output: string): TestResult {
  const lines = output.split("\n");
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let durationMs = 0;
  const failures: TestFailure[] = [];

  // Summary line: "== 3 failed, 10 passed, 2 warnings in 1.23s =="
  const summary = /=+\s*(.*?)\s*in\s+(\d+(?:\.\d+)?)s\s*=+/.exec(output);
  if (summary) {
    const body = summary[1];
    durationMs = Math.round(parseFloat(summary[2]) * 1000);
    const fm = /(\d+)\s+failed/.exec(body); if (fm) fail = parseInt(fm[1], 10);
    const pm = /(\d+)\s+passed/.exec(body); if (pm) pass = parseInt(pm[1], 10);
    const sm = /(\d+)\s+(?:skipped|deselected)/.exec(body); if (sm) skip = parseInt(sm[1], 10);
  }

  // FAILED lines: "FAILED tests/test_foo.py::test_name - ExcType: message"
  const failedRe = /^FAILED\s+([\w/.\-]+\.py)(?:::(.+?))?\s*(?:-\s*(.+))?$/;
  // Also capture short tb blocks: "_ test_name _" followed by error lines
  const shortTbHeaderRe = /^_{3,}\s+(.+?)\s+_{3,}$/;
  const locationRe = /^([\w/.\-]+\.py):(\d+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const fm = failedRe.exec(line);
    if (fm) {
      const file = fm[1];
      const testName = fm[2] ?? "";
      const message = fm[3] ?? "";
      failures.push({ file, testName, message, stack: [] });
      continue;
    }

    const tbm = shortTbHeaderRe.exec(line);
    if (tbm) {
      const testName = tbm[1];
      const stackLines: string[] = [];
      let message = "";
      let file = "";
      let lineNo: number | undefined;
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith("_")) {
        const l = lines[j].trim();
        if (l) {
          const lm = locationRe.exec(l);
          if (lm && !file) { file = lm[1]; lineNo = parseInt(lm[2], 10); }
          if (l.startsWith("E ")) message = l.slice(2);
          else if (l.startsWith("AssertionError") || l.startsWith("Error")) message = l;
          else stackLines.push(l);
        }
        j++;
      }
      // Avoid double-counting FAILED lines already captured
      if (!failures.some((f) => f.testName === testName)) {
        failures.push({ file, line: lineNo, testName, message, stack: stackLines });
      }
      continue;
    }
  }

  if (fail === 0 && failures.length > 0) fail = failures.length;

  return { pass, fail, skip, durationMs, failures };
}

// ---------------------------------------------------------------------------
// go test
// ---------------------------------------------------------------------------

export function parseGoTest(output: string): TestResult {
  const lines = output.split("\n");
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let durationMs = 0;
  const failures: TestFailure[] = [];

  // Detect JSON mode (go test -json)
  const isJson = lines.some((l) => {
    try { const o = JSON.parse(l); return o.Action !== undefined; } catch { return false; }
  });

  if (isJson) {
    // Accumulate output per test name
    const testOutput = new Map<string, string[]>();
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      const { Action, Test, Output, Elapsed } = ev;
      if (!Test) {
        if (Action === "pass" && Elapsed) durationMs = Math.round(Elapsed * 1000);
        continue;
      }
      if (Action === "output") {
        const arr = testOutput.get(Test) ?? [];
        arr.push((Output ?? "").trimEnd());
        testOutput.set(Test, arr);
      } else if (Action === "pass") {
        pass++;
      } else if (Action === "fail") {
        fail++;
        const outLines = testOutput.get(Test) ?? [];
        const message = outLines.find((l) => l.includes("Error") || l.includes("FAIL") || l.includes("---")) ?? "";
        const stack = outLines.filter((l) => /\w+_test\.go:\d+/.test(l));
        // Extract file:line from stack
        let file = "";
        let lineNo: number | undefined;
        if (stack[0]) {
          const m = /(\w+_test\.go):(\d+)/.exec(stack[0]);
          if (m) { file = m[1]; lineNo = parseInt(m[2], 10); }
        }
        failures.push({ file, line: lineNo, testName: Test, message, stack });
      } else if (Action === "skip") {
        skip++;
      }
    }
  } else {
    // Plain mode: "--- FAIL: TestName (0.00s)"
    const failRe = /^--- FAIL:\s+(\S+)\s+\((\d+(?:\.\d+)?)s\)/;
    const passRe = /^--- PASS:\s+/;
    const skipRe = /^--- SKIP:\s+/;
    const okRe   = /^ok\s+\S+\s+(\d+(?:\.\d+)?)s/;
    const fileRe = /(\w+_test\.go):(\d+)/;

    let currentFail: TestFailure | null = null;

    for (const line of lines) {
      const fm = failRe.exec(line);
      if (fm) {
        if (currentFail) failures.push(currentFail);
        fail++;
        currentFail = { file: "", testName: fm[1], message: "", stack: [] };
        durationMs += Math.round(parseFloat(fm[2]) * 1000);
        continue;
      }
      if (passRe.test(line)) { pass++; if (currentFail) { failures.push(currentFail); currentFail = null; } continue; }
      if (skipRe.test(line)) { skip++; continue; }
      const ok = okRe.exec(line);
      if (ok) { durationMs = Math.round(parseFloat(ok[1]) * 1000); continue; }

      if (currentFail) {
        const trimmed = line.trim();
        if (!currentFail.message && trimmed) currentFail.message = trimmed;
        const lm = fileRe.exec(line);
        if (lm) {
          if (!currentFail.file) { currentFail.file = lm[1]; currentFail.line = parseInt(lm[2], 10); }
          currentFail.stack.push(trimmed);
        }
      }
    }
    if (currentFail) failures.push(currentFail);
  }

  return { pass, fail, skip, durationMs, failures };
}

// ---------------------------------------------------------------------------
// Generic TAP-like fallback
// ---------------------------------------------------------------------------

export function parseGenericTap(output: string): TestResult {
  const lines = output.split("\n");
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let durationMs = 0;
  const failures: TestFailure[] = [];

  // TAP format: "ok N - description" / "not ok N - description"
  const okRe   = /^ok\s+\d+\s+-?\s*(.+)/;
  const notOkRe = /^not ok\s+\d+\s+-?\s*(.+)/;
  // Generic PASS/FAIL lines
  const passRe = /\bPASS(?:ED)?\b/;
  const failRe = /\bFAIL(?:ED)?\b/;
  const skipRe = /\bSKIP(?:PED)?\b/;

  let currentFail: TestFailure | null = null;

  for (const line of lines) {
    const ok = okRe.exec(line);
    if (ok) { pass++; if (currentFail) { failures.push(currentFail); currentFail = null; } continue; }

    const nok = notOkRe.exec(line);
    if (nok) {
      if (currentFail) failures.push(currentFail);
      fail++;
      currentFail = { file: "", testName: nok[1].trim(), message: "", stack: [] };
      continue;
    }

    if (passRe.test(line)) { pass++; continue; }
    if (skipRe.test(line)) { skip++; continue; }
    if (failRe.test(line)) {
      fail++;
      if (currentFail) failures.push(currentFail);
      currentFail = { file: "", testName: line.trim(), message: "", stack: [] };
      continue;
    }

    if (currentFail) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) {
        const msg = trimmed.slice(1).trim();
        if (!currentFail.message) currentFail.message = msg;
        else currentFail.stack.push(msg);
      }
    }
  }

  if (currentFail) failures.push(currentFail);

  // Duration: look for "# time=Xs" (TAP) or generic "in Xs"
  const dur = /(?:time|duration)[=:\s]+(\d+(?:\.\d+)?(?:ms|s))/i.exec(output);
  if (dur) durationMs = parseMs(dur[1]);

  return { pass, fail, skip, durationMs, failures };
}
