/**
 * Affected root tests for the Windows and macOS pull-request legs.
 * Usage: BASE_SHA=<40-hex> bun scripts/os-affected-tests.ts
 *
 * A full selection runs the shared CI runner. A narrow selection runs those
 * files with --bail=1 and the same failure report. The base must be a
 * 40-character commit SHA. It is not taken from the command line.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { affectedTests } from "./affected-tests.ts";
import { resolveCommand } from "./resolve-command";
import { timingBudgetMs } from "./timing-budget.ts";
import { publishUnitFailure } from "./unit-test-failure-report.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Allow only a full commit SHA, so the value cannot be a git option or a revision expression. */
export function commitSha(value: string | undefined): string | undefined {
  return /^([0-9a-f]{40})$/i.exec(value ?? "")?.[1];
}

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
  const requested = commitSha(process.env.BASE_SHA);
  if (!requested) {
    console.error("usage: BASE_SHA=<40-hex> bun scripts/os-affected-tests.ts");
    process.exit(1);
  }
  const git = resolveCommand("git");
  const verified = commitSha(execFileSync(git, ["rev-parse", "--verify", "--end-of-options", requested], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim());
  if (!verified) {
    console.error("BASE_SHA did not resolve to a commit");
    process.exit(1);
  }
  const mergeBase = commitSha(execFileSync(git, ["merge-base", "--end-of-options", verified, "HEAD"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim());
  if (!mergeBase) {
    console.error("merge-base did not resolve to a commit");
    process.exit(1);
  }
  const diff = execFileSync(git, ["diff", "--name-status", "-z", "--no-renames", mergeBase, "HEAD", "--"], {
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
