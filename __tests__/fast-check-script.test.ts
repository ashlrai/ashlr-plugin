#!/usr/bin/env bun
/**
 * fast-check-script.test.ts — integration tests for scripts/fast-check.sh.
 *
 * Exercises the changed-file selection via the shell script's internal
 * flow (diff → affected-tests.ts → test runner) using temporary git
 * repos, keeping the real repo's git history untouched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FAST_CHECK = resolve(import.meta.dir, "../scripts/fast-check.sh");
const SCRIPTS_DIR = resolve(import.meta.dir, "../scripts");

describe("fast-check script", () => {
  let root: string;
  let origin: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();

  beforeAll(() => {
    // Create a bare origin repo to serve as a proper remote.
    origin = mkdtempSync(join(tmpdir(), "fast-check-origin-"));
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: origin, stdio: "pipe" });
    execFileSync("git", ["config", "receive.denyCurrentBranch", "ignore"], {
      cwd: origin, stdio: "pipe",
    });

    // Clone into a working copy (non-bare).
    root = mkdtempSync(join(tmpdir(), "fast-check-"));
    execFileSync("git", ["clone", origin, root], { stdio: "pipe" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
    // Keep fixture commits independent of the runner's identity and hostname.
    git("config", "user.useConfigOnly", "true");
    git("config", "user.name", "Fast Check Fixture");
    git("config", "user.email", "fast-check@example.invalid");

    // Create source files in the working copy and commit.
    mkdirSync(join(root, "servers"));
    writeFileSync(join(root, "servers/_text-helpers.ts"), "export const value = 1;\n");
    mkdirSync(join(root, "__tests__"));
    writeFileSync(
      join(root, "__tests__/text-helpers.test.ts"),
      'import { test } from "bun:test";\ntest("placeholder", () => {});\n',
    );

    git("add", ".");
    git("commit", "-m", "initial");

    // Push to origin so origin/main exists on the remote.
    git("push", "origin", "main");
  });

  afterAll(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(origin, { recursive: true, force: true }); } catch { /* */ }
  });

  // ── Changed-file selection via the affected-tests.ts CLI ──────────

  test("configures a repository-local identity for fixture commits", () => {
    expect(git("config", "--local", "user.name")).toBe("Fast Check Fixture");
    expect(git("config", "--local", "user.email")).toBe("fast-check@example.invalid");
  });

  test("empty diff when on main (no feature-branch changes)", () => {
    const diff = git("diff", "--name-status", "-z", "--no-renames", "origin/main...HEAD", "--");
    expect(diff).toBe("");
  });

  test("selects affected test suites when source files change", () => {
    git("checkout", "-b", "feature");
    const newFile = join(root, "servers", "_math-utils.ts");
    writeFileSync(newFile, "export const add = (a: number, b: number) => a + b;\n");
    git("add", newFile);
    git("commit", "-m", "add math-utils");

    // Simulate the diff that fast-check.sh would compute.
    const diff = git("diff", "--name-status", "-z", "--no-renames", "origin/main...HEAD", "--");
    expect(diff).toContain("_math-utils.ts");

    // Feed the diff through the affected-tests.ts CLI.
    const result = execFileSync(
      process.execPath,
      [SCRIPTS_DIR + "/affected-tests.ts", "origin/main"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();

    // A server source change should select the server test suite.
    const targets = JSON.parse(result) as string[];
    expect(targets).toContain("./server/tests");
  });

  test("selects individual test file when only a test changes", () => {
    git("checkout", "main");
    const testFile = join(root, "__tests__", "text-helpers.test.ts");
    writeFileSync(testFile, 'import { test } from "bun:test";\ntest("updated", () => {});\n');
    git("add", testFile);
    git("commit", "-m", "update text-helpers test");

    const result = execFileSync(
      process.execPath,
      [SCRIPTS_DIR + "/affected-tests.ts", "origin/main"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();

    const targets = JSON.parse(result) as string[];
    expect(targets).toEqual(["./__tests__/text-helpers.test.ts"]);
  });

  test("selects affected test suites when docs branch also picks up prior main changes", () => {
    // The "docs-only" test scenario starts from main, but main has the
    // per-test "update text-helpers test" commit from the previous test.
    // A feature branch that only adds docs inherits those main changes,
    // so the diff includes the test-file modification — selecting the
    // individual test suite is the correct outcome.
    git("checkout", "-b", "docs-only");
    const docFile = join(root, "docs", "example.md");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(docFile, "# Example\n");
    git("add", docFile);
    git("commit", "-m", "docs update");

    const result = execFileSync(
      process.execPath,
      [SCRIPTS_DIR + "/affected-tests.ts", "origin/main"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();

    const targets = JSON.parse(result) as string[];
    expect(targets).toEqual(["./__tests__/text-helpers.test.ts"]);
  });

  test("selects full suite when source changes touch multiple packages", () => {
    git("checkout", "-b", "multi");
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "servers", "_math-utils.ts"), "export const add = (a: number, b: number) => a + b;\n");
    writeFileSync(join(root, "hooks", "_hooks.ts"), "export const hook = () => {};\n");
    git("add", ".");
    git("commit", "-m", "multi change");

    const result = execFileSync(
      process.execPath,
      [SCRIPTS_DIR + "/affected-tests.ts", "origin/main"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();

    const targets = JSON.parse(result) as string[];
    // Changing servers/ and hooks/ should select all three test suites.
    expect(targets).toContain("./__tests__");
    expect(targets).toContain("./server/tests");
    expect(targets).toContain("./integration/tests");
  });

  // ── Shell script end-to-end ──────────────────────────────────────

  test("exits 0 on clean main (no diffs against origin/main)", async () => {
    git("checkout", "main");
    const result = spawnSync("bash", [FAST_CHECK], {
      cwd: root,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(result.status).toBe(0);
  });

  test("exits 0 when diff contains only config files (ALL fast-tracks to exit)", async () => {
    const src = join(root, "bun.lock");
    writeFileSync(src, "lock-data");
    git("add", src);
    git("commit", "-m", "add lock");

    const result = spawnSync("bash", [FAST_CHECK], {
      cwd: root,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(result.status).toBe(0);
  });

  test("exits 0 when diff contains only documentation/markdown fixtures", async () => {
    const newTg = join(root, "docs", "_text-helpers.ts");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(newTg, "export const value = 2;\n");
    git("add", newTg);

    const result = spawnSync("bash", [FAST_CHECK], {
      cwd: root,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(result.status).toBe(0);
  });

  test("fast-check exits 0 even with feature-branch source changes", async () => {
    git("checkout", "-b", "feature-src");

    const newSrc = join(root, "servers", "_math-utils.ts");
    writeFileSync(newSrc, "export const add = (a: number, b: number) => a + b;\n");
    try {
      git("add", newSrc);
      git("commit", "-m", "add math-utils");
    } catch { /* already committed */ }

    const result = spawnSync("bash", [FAST_CHECK], {
      cwd: root,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    // The script should exit 0 — it only fails when bun test itself fails.
    expect(result.status).toBe(0);
  });
});
