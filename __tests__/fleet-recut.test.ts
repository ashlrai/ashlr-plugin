import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recut, type Runner } from "../scripts/fleet-recut.ts";

// Real Git fixtures exercise three-way application and worktree isolation;
// only network, installation and test execution are replaced.
for (const scenario of ["conflict", "recut", "failed-test", "retry", "unknown", "clean", "push-retry"] as const) {
  test(scenario, () => {
    const root = mkdtempSync(join(tmpdir(), "recut-fixture-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const calls: string[][] = [];
    let checked = false;
    let pushed = "";
    let createAttempts = 0;
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "commit.gpgsign", "false");
      writeFileSync(join(root, "README.md"), "base\n");
      git("add", "."); git("commit", "-m", "base");
      git("checkout", "-b", "source");
      writeFileSync(join(root, "README.md"), "source\n");
      mkdirSync(join(root, "__tests__"));
      writeFileSync(join(root, "__tests__/fixture.test.ts"), 'import { test, expect } from "bun:test"; import { readFileSync } from "node:fs"; test("recut includes both changes", () => { expect(readFileSync("README.md", "utf8")).toBe("source\\n"); expect(readFileSync("upstream.txt", "utf8")).toBe("upstream\\n"); });');
      git("add", "."); git("commit", "-m", "source");
      const head = git("rev-parse", "HEAD");
      git("checkout", "main");
      writeFileSync(join(root, scenario === "conflict" ? "README.md" : "upstream.txt"), "upstream\n");
      git("add", "."); git("commit", "-m", "upstream");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      writeFileSync(join(root, ".git/FETCH_HEAD"), `${head}\n`);
      const runner: Runner = (cwd, command, args, input) => {
        if (command === "bun") return "";
        if (command === "locus") {
          const actual = args.slice(2); calls.push(actual);
          if (actual[0] === "git") {
            if (actual[1] === "ls-remote") return pushed;
            if (actual[1] === "push") pushed = actual[3]!.split(":")[0]!;
            if (actual[1] === "fetch") writeFileSync(join(root, ".git/FETCH_HEAD"), `${actual[3]?.startsWith("fleet-recut/") ? pushed : head}\n`);
            return "";
          }
          if (actual[2] === "view") return JSON.stringify({ state: "OPEN", baseRefName: "main", isCrossRepository: false,
            headRefOid: head, mergeable: scenario === "unknown" ? "UNKNOWN" : scenario === "clean" ? "MERGEABLE" : "CONFLICTING" });
          if (actual[2] === "list") return JSON.stringify(scenario === "retry" ? [{ number: 99, state: "OPEN", headRefOid: head }] : []);
          if (actual[2] === "create" && scenario === "push-retry" && createAttempts++ === 0) throw new Error("interrupted");
          return "https://github.com/ashlrai/ashlr-plugin/pull/99";
        }
        return execFileSync(command, args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      };
      const action = () => recut(root, 7, runner, (cwd, targets) => {
        checked = true;
        expect(targets).toEqual(["./__tests__/fixture.test.ts"]);
        expect(execFileSync("git", ["show", ":README.md"], { cwd, encoding: "utf8" })).toBe("source\n");
        if (scenario === "failed-test") writeFileSync(join(cwd, "__tests__/fixture.test.ts"), 'import { test, expect } from "bun:test"; test("failure", () => expect(false).toBe(true));');
        execFileSync(process.execPath, ["test", ...targets], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      });
      if (scenario === "push-retry") expect(action).toThrow("interrupted");
      if (["conflict", "failed-test", "unknown"].includes(scenario)) expect(action).toThrow();
      else expect(action()).toBe(scenario === "retry" ? "existing:99" : scenario === "clean" ? "clean" : "https://github.com/ashlrai/ashlr-plugin/pull/99");
      const published = calls.some(c => c[0] === "git" && c[1] === "push");
      expect(published).toBe(scenario === "recut" || scenario === "push-retry");
      expect(checked).toBe(["recut", "failed-test", "push-retry"].includes(scenario));
      expect(git("status", "--porcelain")).toBe("");
      expect(git("worktree", "list", "--porcelain").match(/worktree /g)?.length).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
