import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { affectedTests } from "../scripts/affected-tests.ts";
import fixtures from "./fixtures/affected-tests/diffs.json";

describe("affected test selection", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      expect<unknown>(affectedTests(`${fixture.records.join("\0")}\0`)).toEqual(fixture.expected);
    });
  }
  test("empty diff", () => expect(affectedTests("")).toEqual([]));
  test("malformed output fails instead of skipping", () => {
    for (const diff of ["M\tfile.ts\n", "M\0", "R100\0old\0new\0", "M\0../escape\0"]) {
      expect(() => affectedTests(diff)).toThrow();
    }
  });
  describe("CLI", () => {
    let root: string;
    const script = resolve(import.meta.dir, "../scripts/affected-tests.ts");
    const git = (...args: string[]) => execFileSync("git", args, {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args], {
      cwd: join(root, "nested"), env: process.env,
    });
    const commit = () => {
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
    };
    // Keep fixture construction outside the CLI test budgets. Each invocation
    // retains the default timeout and all fail-closed assertions.
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "affected-tests-"));
      git("init", "-b", "main");
      mkdirSync(join(root, "servers"));
      writeFileSync(join(root, "servers/module.ts"), "export const value = 1;\n");
      commit();
      git("branch", "unchanged");
      git("checkout", "-b", "base");
      writeFileSync(join(root, "bun.lock"), "base-only change");
      commit();
      git("checkout", "main");
      git("mv", "servers/module.ts", "README.md");
      commit();
      mkdirSync(join(root, "nested"));
    });
    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    test("uses the merge base rather than changes exclusive to the base branch", () => {
      git("checkout", "unchanged");
      try {
        const result = run("base");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString().trim()).toBe("[]");
      } finally {
        git("checkout", "main");
      }
    });
    test("includes both rename paths", () => {
      const renamed = run("base");
      expect(renamed.exitCode).toBe(0);
      expect(JSON.parse(renamed.stdout.toString())).toEqual(["./__tests__", "./integration/tests", "./server/tests"]);
    });
    for (const base of ["missing-ref", "--help"]) {
      test(`fails closed for base ${base}`, () => {
        const failed = run(base);
        expect(failed.exitCode).not.toBe(0);
        expect(failed.stdout.toString()).toBe("");
      });
    }
    for (const args of [[], [""], ["base", "HEAD"]]) {
      test(`rejects invalid arguments ${JSON.stringify(args)}`, () => {
        const failed = run(...args);
        expect(failed.exitCode).toBe(1);
        expect(failed.stdout.toString()).toBe("");
        expect(failed.stderr.toString()).toContain("Usage:");
      });
    }
  });
});
