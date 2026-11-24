#!/usr/bin/env bun

import { fileURLToPath } from "node:url";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRootTestDocs } from "./prepare-root-test-docs.ts";
import { discoverRootTests, readPartitionedRootTestCompletion, readRootTestCompletion } from "./root-test-completion.ts";
import { timingBudgetMs } from "./timing-budget.ts";
import { publishUnitFailure } from "./unit-test-failure-report.ts";

function ciRun(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI;
  return !!ci && ci !== "0" && ci.toLowerCase() !== "false";
}

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
// Stop the suite at the first failure on CI. Local runs still report every
// failure. No extra timeout: the per-test budget stays timingBudgetMs.
const onCi = ciRun(process.env);
if (onCi) args.push("--bail=1");
const root = fileURLToPath(new URL("..", import.meta.url));
const inventory = discoverRootTests(root);
const reportDir = mkdtempSync(join(tmpdir(), "ashlr-root-suite-"));
const serializedFile = process.platform === "win32"
  ? realpathSync(join(root, "__tests__", "hook-timings-bounded.test.ts")) : "";
// Its 12 real writers already contend with each other. Schedule this durable
// I/O regression separately from unrelated files, keeping all original bounds.
const partitions = process.platform === "win32" ? [
  { files: inventory.filter(path => path === serializedFile), filters: [serializedFile] },
  { files: inventory.filter(path => path !== serializedFile), filters: ["--path-ignore-patterns=**/hook-timings-bounded.test.ts", "__tests__"] },
] : [{ files: inventory, filters: ["__tests__"] }];
let exitCode = 0;
const reports: { path: string; expectedFiles: string[]; startedMs: number }[] = [];
try {
  for (const [index, partition] of partitions.entries()) {
    if (!partition.files.length) throw new Error("Root partition is empty");
    const path = join(reportDir, `completion-${index}.xml`);
    const startedMs = Date.now();
    const child = Bun.spawn({
      cmd: [...args, "--reporter=junit", `--reporter-outfile=${path}`, ...partition.filters],
      cwd: root,
      env: { ...process.env, ASHLR_STATS_SYNC: "1" },
      stdin: "inherit",
      stdout: onCi ? "pipe" : "inherit",
      stderr: onCi ? "pipe" : "inherit",
    });
    let captured = "";
    if (onCi && child.stdout && child.stderr) {
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      captured = err ? `${out}\n${err}` : out;
    }
    const status = await child.exited;
    if (status !== 0) {
      exitCode = status || 1;
      if (onCi) publishUnitFailure(captured, root);
      break;
    }
    if (onCi && captured) process.stdout.write(captured.endsWith("\n") ? captured : `${captured}\n`);
    reports.push({ path, expectedFiles: partition.files, startedMs });
    // Reject exit-zero/incomplete children before launching the next partition.
    readRootTestCompletion(path, partition.files, root);
  }
  if (exitCode === 0) {
    const receipt = process.platform === "win32"
      ? readPartitionedRootTestCompletion(reports, inventory, root)
      : readRootTestCompletion(reports[0]!.path, inventory, root);
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
