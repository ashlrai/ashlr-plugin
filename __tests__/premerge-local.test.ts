import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_BUDGET_MS,
  parseSelection,
  runPremerge,
  testCommands,
  type CommandResult,
  type CommandSpec,
  type Runner,
} from "../scripts/premerge-local.ts";

const ROOT = "/repo";

type Fake = Partial<CommandResult> & { advanceMs?: number };

/**
 * Runner double: returns canned results per spec name, honours the passed
 * timeout (advanceMs beyond it reports timedOut), and advances a fake clock
 * so runPremerge's budget bookkeeping is deterministic.
 */
function harness(map: Record<string, Fake>) {
  let t = 1_000;
  const calls: CommandSpec[] = [];
  const timeouts = new Map<string, number>();
  const run: Runner = (spec, timeoutMs) => {
    calls.push(spec);
    timeouts.set(spec.name, timeoutMs);
    const f = map[spec.name];
    if (!f) throw new Error(`unexpected command: ${spec.name}`);
    const advance = f.advanceMs ?? 10;
    t += advance;
    const timedOut = f.timedOut ?? advance > timeoutMs;
    return Promise.resolve({
      stdout: f.stdout ?? "",
      stderr: f.stderr ?? "",
      exitCode: timedOut ? -1 : (f.exitCode ?? 0),
      timedOut,
    });
  };
  return { calls, timeouts, run, now: () => t };
}

const selectTargets = (targets: string[]): Fake => ({ stdout: `${JSON.stringify(targets)}\n` });

describe("parseSelection", () => {
  test("ALL and JSON arrays", () => {
    expect(parseSelection("ALL\n")).toBe("ALL");
    expect(parseSelection('["./__tests__/a.test.ts"]\n')).toEqual(["./__tests__/a.test.ts"]);
    expect(parseSelection("[]")).toEqual([]);
  });
  test("rejects everything else", () => {
    for (const out of ["", "junk", "{}", "[1]", '["a",2]', "ALL ALL"]) {
      expect(() => parseSelection(out)).toThrow();
    }
  });
});

describe("testCommands", () => {
  test("empty selection produces no commands", () => {
    expect(testCommands(ROOT, [])).toEqual([]);
  });
  test("groups root targets into one bun-test call", () => {
    const specs = testCommands(ROOT, ["./__tests__/a.test.ts", "./__tests__/b.test.ts"]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.name).toBe("test:__tests__");
    expect(specs[0]!.cwd).toBe(ROOT);
    expect(specs[0]!.args).toEqual([
      "test",
      expect.stringMatching(/^--timeout=\d+$/),
      ...(process.platform === "win32" ? [] : ["--parallel=4"]),
      "__tests__/a.test.ts",
      "__tests__/b.test.ts",
    ]);
    expect(specs[0]!.env).toEqual({ ASHLR_STATS_SYNC: "1" });
  });
  test("each package suite runs from its own directory", () => {
    const specs = testCommands(ROOT, [
      "./server/tests/s.test.ts",
      "./integration/tests/i.test.ts",
      "./__tests__/r.test.ts",
    ]);
    expect(specs.map((s) => s.name)).toEqual(["test:__tests__", "test:integration", "test:server"]);
    const byName = new Map(specs.map((s) => [s.name, s]));
    expect(byName.get("test:server")!.cwd).toBe("/repo/server");
    expect(byName.get("test:server")!.args.at(-1)).toBe("tests/s.test.ts");
    expect(byName.get("test:integration")!.cwd).toBe("/repo/integration");
    expect(byName.get("test:integration")!.args).toContain("--timeout=30000");
    expect(byName.get("test:integration")!.env).toEqual({ TESTING: "1", ASHLR_DISABLE_CLOUD_LLM: "1" });
  });
  test("ALL fans out to the three suites", () => {
    const specs = testCommands(ROOT, "ALL");
    expect(specs.map((s) => s.name)).toEqual(["test:__tests__", "test:integration", "test:server"]);
    expect(specs.map((s) => s.args.at(-1))).toEqual(["__tests__", "tests", "tests"]);
  });
});

describe("runPremerge", () => {
  test("passes when selection, typecheck and tests all pass", async () => {
    const h = harness({
      "affected-tests": selectTargets(["./__tests__/x.test.ts"]),
      typecheck: {},
      "test:__tests__": { stdout: "1 pass\n" },
    });
    const report = await runPremerge({ base: "main", root: ROOT, run: h.run, now: h.now });
    expect(report.kind).toBe("ashlr.premerge-local");
    expect(report.schema_version).toBe(1);
    expect(report.status).toBe("pass");
    expect(report.steps.map((s) => s.name)).toEqual(["affected-tests", "typecheck", "test:__tests__"]);
    expect(report.steps.every((s) => s.status === "pass")).toBe(true);
    expect(report.tests.selection).toEqual(["./__tests__/x.test.ts"]);
    expect(report.tests.ran).toBe(true);
    expect(report.tests.commands[0]).toContain("test");
    expect(report.tests.commands[0]).toContain("__tests__/x.test.ts");
    const testSpec = h.calls.find((c) => c.name === "test:__tests__")!;
    expect(testSpec.cwd).toBe(ROOT);
    expect(testSpec.args.at(-1)).toBe("__tests__/x.test.ts");
    // Selection is capped so a slow diff cannot eat the whole budget.
    expect(h.timeouts.get("affected-tests")!).toBeLessThanOrEqual(15_000);
  });

  test("fails when a selected test fails", async () => {
    const h = harness({
      "affected-tests": selectTargets(["./__tests__/x.test.ts"]),
      typecheck: {},
      "test:__tests__": { exitCode: 1, stderr: "1 fail\n" },
    });
    const report = await runPremerge({ base: "main", root: ROOT, run: h.run, now: h.now });
    expect(report.status).toBe("fail");
    const step = report.steps.find((s) => s.name === "test:__tests__")!;
    expect(step.status).toBe("fail");
    expect(step.exitCode).toBe(1);
    expect(step.stderrTail).toContain("1 fail");
    expect(report.tests.ran).toBe(true);
  });

  test("fails when typecheck fails even if tests pass", async () => {
    const h = harness({
      "affected-tests": selectTargets(["./__tests__/x.test.ts"]),
      typecheck: { exitCode: 2, stderr: "error TS2322" },
      "test:__tests__": {},
    });
    const report = await runPremerge({ base: "main", root: ROOT, run: h.run, now: h.now });
    expect(report.status).toBe("fail");
    expect(report.steps.find((s) => s.name === "typecheck")!.stderrTail).toContain("TS2322");
  });

  test("no affected tests: typecheck still runs, tests report skipped", async () => {
    const h = harness({
      "affected-tests": selectTargets([]),
      typecheck: {},
    });
    const report = await runPremerge({ base: "main", root: ROOT, run: h.run, now: h.now });
    expect(report.status).toBe("pass");
    expect(report.tests.selection).toEqual([]);
    expect(report.tests.ran).toBe(false);
    expect(report.tests.commands).toEqual([]);
    expect(h.calls.map((c) => c.name)).toEqual(["affected-tests", "typecheck"]);
    const skip = report.steps.find((s) => s.name === "tests")!;
    expect(skip.status).toBe("skip");
    expect(skip.note).toContain("no targets");
  });

  test("selection failure fails closed but still runs typecheck", async () => {
    const h = harness({
      "affected-tests": { exitCode: 1, stderr: "usage" },
      typecheck: {},
    });
    const report = await runPremerge({ base: "missing-ref", root: ROOT, run: h.run, now: h.now });
    expect(report.status).toBe("fail");
    expect(report.tests.selection).toBeNull();
    expect(report.tests.ran).toBe(false);
    expect(report.steps.map((s) => s.name)).toEqual(["affected-tests", "typecheck"]);
    expect(h.calls.map((c) => c.name)).toEqual(["affected-tests", "typecheck"]);
  });

  test("unparseable selector output fails closed", async () => {
    const h = harness({
      "affected-tests": { stdout: "not json\n" },
      typecheck: {},
    });
    const report = await runPremerge({ base: "main", root: ROOT, run: h.run, now: h.now });
    expect(report.status).toBe("fail");
    const select = report.steps.find((s) => s.name === "affected-tests")!;
    expect(select.status).toBe("fail");
    expect(select.note).toBeTruthy();
  });

  test("a step exceeding the shared budget fails the run", async () => {
    const h = harness({
      "affected-tests": selectTargets(["./__tests__/x.test.ts"]),
      typecheck: {},
      "test:__tests__": { advanceMs: 500 },
    });
    const report = await runPremerge({ base: "main", root: ROOT, budgetMs: 400, run: h.run, now: h.now });
    expect(report.status).toBe("fail");
    const step = report.steps.find((s) => s.name === "test:__tests__")!;
    expect(step.status).toBe("fail");
    expect(step.timedOut).toBe(true);
    expect(h.timeouts.get("test:__tests__")!).toBeLessThan(400);
  });

  test("steps that cannot start before the deadline fail closed unspawned", async () => {
    const h = harness({
      // Selection squeaks in at its cap (300 - 250 reserve = 50), leaving no
      // budget for typecheck or the test group.
      "affected-tests": { ...selectTargets(["./__tests__/x.test.ts"]), advanceMs: 50 },
    });
    const report = await runPremerge({ base: "main", root: ROOT, budgetMs: 300, run: h.run, now: h.now });
    expect(report.status).toBe("fail");
    expect(report.steps.find((s) => s.name === "affected-tests")!.status).toBe("pass");
    expect(h.calls.map((c) => c.name)).toEqual(["affected-tests"]);
    for (const name of ["typecheck", "test:__tests__"]) {
      const step = report.steps.find((s) => s.name === name)!;
      expect(step.status).toBe("fail");
      expect(step.note).toBe("budget exhausted before start");
    }
  });
});

describe("CLI", () => {
  const script = resolve(import.meta.dir, "../scripts/premerge-local.ts");
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, script, ...args], { env: process.env });
  const usageError = (stderr: string) => {
    expect(stderr).toContain("Usage:");
    expect(stderr).toContain("--budget-ms");
  };

  test("requires a base ref", () => {
    const r = run();
    expect(r.exitCode).toBe(1);
    usageError(r.stderr.toString());
    expect(r.stdout.toString()).toBe("");
  });
  test("rejects flag-like bases and unknown flags", () => {
    for (const args of [["--help"], ["HEAD", "--bogus"], ["-x"]]) {
      const r = run(...args);
      expect(r.exitCode).toBe(1);
      usageError(r.stderr.toString());
    }
  });
  test("rejects non-positive budgets", () => {
    for (const args of [["HEAD", "--budget-ms", "0"], ["HEAD", "--budget-ms=-5"], ["HEAD", "--budget-ms", "abc"]]) {
      const r = run(...args);
      expect(r.exitCode).toBe(1);
      usageError(r.stderr.toString());
    }
  });
  test("default budget is one minute", () => {
    expect(DEFAULT_BUDGET_MS).toBe(60_000);
  });
});

describe("CLI end-to-end", () => {
  // A throwaway repo with the real affected-tests script, a no-op typecheck
  // script and one bun test file. premerge-local itself runs from this repo
  // so its imports resolve here; only the selector must exist in the fixture.
  const script = resolve(import.meta.dir, "../scripts/premerge-local.ts");
  let root: string;
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  };
  const writeTest = (failing: boolean) => writeFileSync(join(root, "__tests__/x.test.ts"),
    `import { expect, test } from "bun:test";\ntest("x", () => expect(1).toBe(${failing ? 2 : 1}));\n`);
  const run = (base: string) => Bun.spawnSync([process.execPath, script, base], {
    cwd: join(root, "scripts"), env: process.env,
  });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "premerge-local-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "__tests__"));
    copyFileSync(resolve(import.meta.dir, "../scripts/affected-tests.ts"), join(root, "scripts/affected-tests.ts"));
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "premerge-fixture", type: "module",
      scripts: { typecheck: "bun --version" },
    }));
    git("init", "-b", "main");
    commit();
    git("branch", "base");
    writeTest(false);
    commit();
    git("branch", "passing");
    writeTest(true);
    commit();
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("pass verdict is JSON on stdout with exit 0", () => {
    // The selector diffs base...HEAD but bun test runs worktree contents, so
    // the checked-out branch decides whether the selected test passes.
    git("checkout", "-q", "passing");
    const r = run("base");
    expect(r.stderr.toString()).toBe("");
    const verdict = JSON.parse(r.stdout.toString());
    expect(r.exitCode).toBe(0);
    expect(verdict.kind).toBe("ashlr.premerge-local");
    expect(verdict.status).toBe("pass");
    expect(verdict.tests.ran).toBe(true);
    expect(verdict.tests.commands[0]).toContain("__tests__/x.test.ts");
    expect(verdict.steps.map((s: { name: string }) => s.name)).toEqual(["affected-tests", "typecheck", "test:__tests__"]);
  });
  test("failing test fails the run with exit 1", () => {
    git("checkout", "-q", "main");
    const r = run("passing");
    const verdict = JSON.parse(r.stdout.toString());
    expect(r.exitCode).toBe(1);
    expect(verdict.status).toBe("fail");
    const step = verdict.steps.find((s: { name: string }) => s.name === "test:__tests__");
    expect(step.status).toBe("fail");
    expect(step.stderrTail + step.stdoutTail).toContain("fail");
  });
  test("no-affected-tests verdict skips the test phase", () => {
    git("checkout", "-q", "main");
    const r = run("HEAD");
    const verdict = JSON.parse(r.stdout.toString());
    expect(r.exitCode).toBe(0);
    expect(verdict.status).toBe("pass");
    expect(verdict.tests).toEqual({ selection: [], commands: [], ran: false });
  });
});
