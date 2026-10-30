#!/usr/bin/env bun
/**
 * Usage: bun scripts/premerge-local.ts <base> [--budget-ms <n>]
 *
 * Worker-side pre-merge check. PR CI runs only the seconds-fast gate, so a
 * break otherwise surfaces first at the daily full suite. This runs the
 * checks a small diff can afford inside the worktree before merge:
 *
 *   1. scripts/affected-tests.ts <base> picks the Bun test targets for
 *      committed changes at base...HEAD (staged/untracked files excluded).
 *      Selection failure fails closed — a skip is never synthesized.
 *   2. `bun run typecheck` (tsc --noEmit) — the same command CI's gate runs.
 *   3. `bun test` on the selected targets, grouped per package: __tests__
 *      targets run at the worktree root, server/tests under server/,
 *      integration/tests under integration/, so each suite resolves its own
 *      bunfig and node_modules. ALL maps to all three suites; flags and env
 *      mirror `bun run test` and the daily integration job.
 *
 * Typecheck and the test groups run concurrently, each bounded by the shared
 * --budget-ms deadline (default 60s — the contract for a small diff). A step
 * that cannot start before the deadline fails closed with timedOut: true;
 * pass a larger budget for ALL-sized selections or defer to the daily suite.
 *
 * stdout carries a single JSON verdict (kind "ashlr.premerge-local"); child
 * output is captured into the report, not printed. Exit 0 = pass, 1 = fail
 * or invalid usage. An extra check for workers — it replaces no CI gate.
 *
 * Exported for __tests__/premerge-local.test.ts — keep signatures stable.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runWithTimeout } from "../servers/_run-with-timeout.ts";
import type { AffectedTests } from "./affected-tests.ts";
import { timingBudgetMs } from "./timing-budget.ts";

export const DEFAULT_BUDGET_MS = 60_000;
/** Selection is a git diff only; it must never eat the check budget. */
export const SELECT_CAP_MS = 15_000;
/** Reserve so the verdict still prints when a step runs to the deadline. */
const VERDICT_RESERVE_MS = 250;
/** How much of a step's captured output the report retains. */
const TAIL_CHARS = 4_000;

export interface CommandSpec {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  /** Extra environment merged over the parent's for this child. */
  env?: Record<string, string>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or -1 on spawn error. */
  exitCode: number;
  timedOut: boolean;
}

export type Runner = (spec: CommandSpec, timeoutMs: number) => Promise<CommandResult>;

export interface StepReport {
  name: string;
  /** Display-only rendering of the spawned command line. */
  command: string;
  status: "pass" | "fail" | "skip";
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  note?: string;
}

export interface PremergeReport {
  kind: "ashlr.premerge-local";
  schema_version: 1;
  tool: "ashlr-plugin";
  status: "pass" | "fail";
  base: string;
  root: string;
  budgetMs: number;
  tests: {
    /** What affected-tests selected; null when selection itself failed. */
    selection: AffectedTests | null;
    /** Display cmdlines of the test groups actually invoked. */
    commands: string[];
    /** True when at least one test group was spawned. */
    ran: boolean;
  };
  steps: StepReport[];
  durationMs: number;
}

export interface PremergeOptions {
  base: string;
  /** Worktree root; defaults to `git rev-parse --show-toplevel`. */
  root?: string;
  /** Shared wall-clock deadline for all steps. */
  budgetMs?: number;
  /** Command executor; tests inject a fake. Defaults to runWithTimeout. */
  run?: Runner;
  now?: () => number;
}

const defaultRunner: Runner = async (spec, timeoutMs) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, spec.env);
  const r = await runWithTimeout({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env,
    timeoutMs,
  });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut };
};

function gitRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tail(s: string): string {
  return s.length <= TAIL_CHARS ? s : s.slice(-TAIL_CHARS);
}

/** Parse affected-tests stdout: literal ALL or a JSON string array. */
export function parseSelection(stdout: string): AffectedTests {
  const text = stdout.trim();
  if (text === "ALL") return "ALL";
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) {
    throw new Error("affected-tests printed neither ALL nor a JSON array");
  }
  return parsed;
}

/**
 * Map affected-tests targets to bun-test invocations. Targets are
 * repo-relative "./..." paths; each suite's tests run from their own package
 * directory so bunfig and node_modules resolve. Group order is sorted so the
 * report is deterministic.
 */
export function testCommands(root: string, selection: AffectedTests): CommandSpec[] {
  const targets = selection === "ALL"
    ? ["./__tests__", "./server/tests", "./integration/tests"]
    : selection;
  const groups = new Map<string, string[]>();
  for (const target of targets) {
    const rel = target.startsWith("./") ? target.slice(2) : target;
    const dir = rel.startsWith("server/") ? "server"
      : rel.startsWith("integration/") ? "integration"
      : ".";
    const list = groups.get(dir) ?? [];
    list.push(dir === "." ? rel : rel.slice(dir.length + 1));
    groups.set(dir, list);
  }
  // Flags mirror the daily suite: run-root-tests.ts scales the per-test
  // timeout and parallelizes POSIX workers; integration CI passes a literal
  // 30s timeout with its own env toggles.
  const timeoutArg = `--timeout=${timingBudgetMs(5_000)}`;
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, filters]) => {
    const env: Record<string, string> | undefined = dir === "." ? { ASHLR_STATS_SYNC: "1" }
      : dir === "integration" ? { TESTING: "1", ASHLR_DISABLE_CLOUD_LLM: "1" }
      : undefined;
    return {
      name: dir === "." ? "test:__tests__" : `test:${dir}`,
      command: process.execPath,
      args: [
        "test",
        dir === "integration" ? "--timeout=30000" : timeoutArg,
        ...(dir === "." && process.platform !== "win32" ? ["--parallel=4"] : []),
        ...filters,
      ],
      cwd: dir === "." ? root : join(root, dir),
      env,
    };
  });
}

export async function runPremerge(opts: PremergeOptions): Promise<PremergeReport> {
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const run = opts.run ?? defaultRunner;
  const started = now();
  const deadline = started + budgetMs;
  const remaining = () => deadline - now();

  const runStep = async (spec: CommandSpec, timeoutMs: number): Promise<StepReport & { stdout: string }> => {
    const t0 = now();
    const r = await run(spec, timeoutMs);
    return {
      name: spec.name,
      command: [spec.command, ...spec.args].join(" "),
      status: r.timedOut || r.exitCode !== 0 ? "fail" : "pass",
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: Math.max(0, now() - t0),
      stdoutTail: tail(r.stdout),
      stderrTail: tail(r.stderr),
      note: r.timedOut ? `exceeded step budget of ${Math.max(0, Math.round(timeoutMs))} ms` : undefined,
      stdout: r.stdout,
    };
  };

  const steps: StepReport[] = [];
  let root = opts.root ?? "";
  let selection: AffectedTests | null = null;

  if (!root) {
    try {
      root = gitRoot();
    } catch {
      steps.push({
        name: "setup",
        command: "git rev-parse --show-toplevel",
        status: "fail",
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        stdoutTail: "",
        stderrTail: "",
        note: "not inside a git worktree",
      });
    }
  }

  const testSpecs: CommandSpec[] = [];
  const commandResults: { spec: CommandSpec; spawned: boolean; step: StepReport }[] = [];

  if (steps.length === 0) {
    const { stdout, ...selectStep } = await runStep(
      {
        name: "affected-tests",
        command: process.execPath,
        args: [join(root, "scripts/affected-tests.ts"), opts.base],
        cwd: root,
      },
      Math.max(0, Math.min(SELECT_CAP_MS, remaining() - VERDICT_RESERVE_MS)),
    );
    if (selectStep.status === "pass") {
      try {
        selection = parseSelection(stdout);
      } catch (error) {
        selectStep.status = "fail";
        selectStep.note = error instanceof Error ? error.message : String(error);
      }
    }
    steps.push(selectStep);

    // Typecheck runs unconditionally ("tsc plus tests"); test groups run only
    // when selection succeeded and produced targets.
    const specs: CommandSpec[] = [
      { name: "typecheck", command: process.execPath, args: ["run", "typecheck"], cwd: root },
    ];
    if (selection !== null) testSpecs.push(...testCommands(root, selection));
    specs.push(...testSpecs);

    commandResults.push(...await Promise.all(specs.map(async (spec) => {
      const left = remaining() - VERDICT_RESERVE_MS;
      if (left <= 0) {
        return {
          spec,
          spawned: false,
          step: {
            name: spec.name,
            command: [spec.command, ...spec.args].join(" "),
            status: "fail" as const,
            exitCode: null,
            timedOut: true,
            durationMs: 0,
            stdoutTail: "",
            stderrTail: "",
            note: "budget exhausted before start",
          },
        };
      }
      const { stdout: _stdout, ...step } = await runStep(spec, left);
      return { spec, spawned: true, step };
    })));
    steps.push(...commandResults.map((r) => r.step));
    if (selection !== null && testSpecs.length === 0) {
      steps.push({
        name: "tests",
        command: "",
        status: "skip",
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        stdoutTail: "",
        stderrTail: "",
        note: "affected-tests selected no targets",
      });
    }
  }

  const status = steps.every((s) => s.status !== "fail") ? "pass" : "fail";
  const testReports = commandResults.filter((r) => r.spec.name.startsWith("test:"));
  return {
    kind: "ashlr.premerge-local",
    schema_version: 1,
    tool: "ashlr-plugin",
    status,
    base: opts.base,
    root,
    budgetMs,
    tests: {
      selection,
      commands: testReports.map((r) => r.step.command),
      ran: testReports.some((r) => r.spawned),
    },
    steps,
    durationMs: Math.max(0, now() - started),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let base: string | undefined;
  let budgetMs = DEFAULT_BUDGET_MS;
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--budget-ms") budgetMs = Number(args[++i]);
    else if (arg.startsWith("--budget-ms=")) budgetMs = Number(arg.slice("--budget-ms=".length));
    else if (!arg.startsWith("-") && base === undefined) base = arg;
    else bad = true;
  }
  if (bad || !base || !Number.isFinite(budgetMs) || budgetMs <= 0) {
    console.error("Usage: bun scripts/premerge-local.ts <base> [--budget-ms <n>]");
    process.exit(1);
  }
  try {
    const report = await runPremerge({ base, budgetMs });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === "pass" ? 0 : 1;
  } catch (error) {
    console.error(`premerge-local: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
