import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSERTION_SUMMARY_LINES, assertionHead, describeUnitFailure, publishUnitFailure } from "../scripts/unit-test-failure-report.ts";

const root = "/tmp/ashlr-plugin";
const log = [
  "__tests__/probe.test.ts:",
  "error: expect(received).toBe(expected)",
  "",
  '- "different"',
  ...Array.from({ length: 50 }, (_, i) => `+ snapshot-line-${i}`),
  "",
  "      at <anonymous> (/tmp/ashlr-plugin/__tests__/probe.test.ts:3:30)",
  "(fail) deliberate CI fast-fail probe [1.00ms]",
  " 0 pass",
].join("\n");

test("annotation points at the failing test and the summary keeps 20 assertion lines", () => {
  const described = describeUnitFailure(log, root);
  expect(described?.annotation).toBe("::error file=__tests__/probe.test.ts,line=3::deliberate CI fast-fail probe");
  const lines = assertionHead(log).split("\n");
  expect(lines).toHaveLength(ASSERTION_SUMMARY_LINES);
  expect(lines[0]).toBe("error: expect(received).toBe(expected)");
  expect(lines.join("\n")).not.toContain("snapshot-line-40");
  expect(described?.summary).toContain("__tests__/probe.test.ts:3");
  expect(described?.summary).not.toContain("snapshot-line-40");
});

test("the full diff is written for an artifact and is not printed", () => {
  const dir = mkdtempSync(join(tmpdir(), "unit-fail-"));
  const summary = join(dir, "summary.md");
  const rooted = log.replaceAll(root, dir);
  const logs: string[] = [];
  const original = console.error;
  console.error = (line?: unknown) => { logs.push(String(line ?? "")); };
  try {
    publishUnitFailure(rooted, dir, { GITHUB_STEP_SUMMARY: summary });
  } finally {
    console.error = original;
  }
  expect(logs.join("\n")).toBe("::error file=__tests__/probe.test.ts,line=3::deliberate CI fast-fail probe");
  expect(logs.join("\n")).not.toContain("snapshot-line-40");
  expect(readFileSync(join(dir, "test-results", "unit-failure.log"), "utf8")).toContain("snapshot-line-40");
  expect(readFileSync(summary, "utf8")).toContain("deliberate CI fast-fail probe");
  rmSync(dir, { recursive: true, force: true });
});
