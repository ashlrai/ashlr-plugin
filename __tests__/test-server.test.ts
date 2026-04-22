/**
 * End-to-end tests for ashlr__test via direct import.
 *
 * Uses tiny synthetic bun scripts so the tests are deterministic,
 * fast, and network-free.
 */

import { describe, expect, test } from "bun:test";
import { join } from "path";
import { writeFileSync } from "fs";
import { ashlrTest } from "../servers/test-server-handlers";

// Use the repo root as cwd — always inside process.cwd() and has package.json
const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT_PATH = join(REPO_ROOT, ".tmp-ashlr-test-fixture.ts");

/** Write a tiny bun script to SCRIPT_PATH and return a command string for it. */
function makeScript(output: string, exitCode = 0): string {
  writeFileSync(
    SCRIPT_PATH,
    `process.stdout.write(${JSON.stringify(output)}); process.exit(${exitCode});\n`,
  );
  return `bun run ${SCRIPT_PATH}`;
}

// ---------------------------------------------------------------------------
// Direct import tests (no MCP round-trip)
// ---------------------------------------------------------------------------

describe("ashlrTest — direct", () => {
  test("cwd clamp rejects paths outside cwd", async () => {
    const result = await ashlrTest({ cwd: "/etc", command: "echo hi" });
    expect(result).toContain("refused path outside working directory");
  });

  test("exit 0 — all passed output parsed", async () => {
    const cmd = makeScript("5 pass · 0 fail · 0 skip · in 10ms\n", 0);
    const result = await ashlrTest({ command: cmd, cwd: REPO_ROOT, runner: "bun" });
    expect(result).toContain("[ashlr__test]");
    expect(result).toContain("5 pass");
    expect(result).toContain("0 fail");
    expect(result).toContain("All tests passed");
  });

  test("exit 1 — failures parsed + formatted", async () => {
    const output = [
      "  ✗ src/foo.test.ts:42 > handles empty array",
      "    AssertionError: expected [] to equal [1]",
      "      at Object.<anonymous> (src/foo.test.ts:42:15)",
      "",
      "1 pass · 1 fail · 0 skip · in 55ms",
    ].join("\n");
    const cmd = makeScript(output, 1);
    const result = await ashlrTest({ command: cmd, cwd: REPO_ROOT, runner: "bun" });
    expect(result).toContain("[ashlr__test]");
    expect(result).toMatch(/fail|✗/);
  });

  test("bypassSummary:false truncates at 2 failures", async () => {
    const output = [
      "  ✗ a.test.ts:1 > test1",
      "    Error: one",
      "  ✗ b.test.ts:2 > test2",
      "    Error: two",
      "  ✗ c.test.ts:3 > test3",
      "    Error: three",
      "0 pass · 3 fail · 0 skip · in 100ms",
    ].join("\n");
    const cmd = makeScript(output, 1);
    const result = await ashlrTest({ command: cmd, cwd: REPO_ROOT, runner: "bun", bypassSummary: false });
    expect(result).toContain("more failure");
  });

  test("bypassSummary:true shows all failures", async () => {
    const output = [
      "  ✗ a.test.ts:1 > test1",
      "    Error: one",
      "  ✗ b.test.ts:2 > test2",
      "    Error: two",
      "  ✗ c.test.ts:3 > test3",
      "    Error: three",
      "0 pass · 3 fail · 0 skip · in 100ms",
    ].join("\n");
    const cmd = makeScript(output, 1);
    const result = await ashlrTest({ command: cmd, cwd: REPO_ROOT, runner: "bun", bypassSummary: true });
    expect(result).not.toContain("more failure");
  });
});
