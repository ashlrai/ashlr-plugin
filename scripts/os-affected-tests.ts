/**
 * Affected root tests for the Windows and macOS pull-request legs.
 * Usage: bun scripts/os-affected-tests.ts <base-sha>
 *
 * A full selection runs the shared CI runner. A narrow selection runs those
 * files with --bail=1 and the same failure report.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { affectedTests } from "./affected-tests.ts";
import { resolveCommand } from "./resolve-command";
import { timingBudgetMs } from "./timing-budget.ts";
import { publishUnitFailure } from "./unit-test-failure-report.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function rootTargets(selection: ReturnType<typeof affectedTests>): string[] | "all" {
  if (selection === "ALL") return "all";
  return selection.filter(target => target === "./__tests__" || target.startsWith("./__tests__/"));
}

async function runCaptured(cmd: string[]): Promise<number> {
  const child = Bun.spawn({
    cmd,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: process.env.CI ?? "1", ASHLR_STATS_SYNC: "1" },
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const status = await child.exited;
  const log = err ? `${out}\n${err}` : out;
  if (status === 0) {
    if (log) process.stdout.write(log.endsWith("\n") ? log : `${log}\n`);
    return 0;
  }
  publishUnitFailure(log, root);
  return status || 1;
}

if (import.meta.main) {
  const baseArg = process.argv[2];
  if (!baseArg || baseArg.startsWith("-")) {
    console.error("usage: bun scripts/os-affected-tests.ts <base-sha>");
    process.exit(1);
  }
  const base = execFileSync(resolveCommand("git"), ["rev-parse", "--verify", "--end-of-options", `${baseArg}^{commit}`], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const diff = execFileSync(resolveCommand("git"), ["diff", "--name-status", "-z", "--no-renames", `${base}...HEAD`, "--"], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const targets = rootTargets(affectedTests(diff));
  if (targets !== "all" && targets.length === 0) {
    console.log("affected tests: no root tests for this diff");
    process.exit(0);
  }
  const cmd = targets === "all"
    ? [process.execPath, "run", "test"]
    : [process.execPath, "test", "--bail=1", `--timeout=${timingBudgetMs(5_000)}`, ...targets];
  process.exit(await runCaptured(cmd));
}
