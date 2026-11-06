#!/usr/bin/env bun

import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRootTestDocs } from "./prepare-root-test-docs.ts";
import { discoverRootTests, readRootTestCompletion } from "./root-test-completion.ts";
import { timingBudgetMs } from "./timing-budget.ts";

// Finish deterministic derived-data preparation before any parallel child starts.
// Generator failures abort this process; no test is silently skipped.
prepareRootTestDocs();

const args = [process.execPath, "test"];
// Bun's default per-test timeout is 5s. On shared CI runners (macOS in
// particular) unchanged subprocess-heavy tests regularly take 5-6s, so scale
// the default there; local runs keep Bun's 5s default. Tests with an explicit
// timeout are unaffected.
const defaultTimeoutMs = timingBudgetMs(5_000);
if (defaultTimeoutMs !== 5_000) args.push(`--timeout=${defaultTimeoutMs}`);
// Shared Windows mode let a hook test's exit-zero timer terminate the entire
// suite. Every platform needs the same per-file global/module isolation.
args.push("--parallel=4");
const root = fileURLToPath(new URL("..", import.meta.url));
const inventory = discoverRootTests(root);
const reportDir = mkdtempSync(join(tmpdir(), "ashlr-root-suite-"));
const reportPath = join(reportDir, "completion.xml");
args.push("--reporter=junit", `--reporter-outfile=${reportPath}`);
args.push("__tests__");

const child = Bun.spawn({
  cmd: args,
  cwd: root,
  env: { ...process.env, ASHLR_STATS_SYNC: "1" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

let exitCode = await child.exited;
try {
  if (exitCode === 0) {
    const receipt = readRootTestCompletion(reportPath, inventory, root);
    console.log(`ROOT_TEST_COMPLETION ${JSON.stringify(receipt)}`);
  }
} catch (error) {
  // Static validator messages are safe; filesystem errors may carry paths.
  // Never print report bodies or their fixture/provider values.
  const detail = error instanceof Error && !("code" in error) ? error.message : "report unavailable";
  console.error(`Root tests did not produce a complete valid JUnit receipt: ${detail}`);
  exitCode = 1;
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
process.exit(exitCode);
