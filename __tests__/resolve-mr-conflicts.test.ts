/**
 * Lane-side conflict resolution for RQ-MR-CONFLICT-DRIVERS.
 *
 * Builds a fixture repo, plants overlapping changes on main and a PR branch
 * and rebases. .gitattributes' `CHANGELOG.md merge=union` driver resolves the
 * changelog without stopping; the helper script resolves README/CLAUDE via
 * union and regenerates the lockfile with bun — all deterministic, no model
 * calls. Unknown files are reported and left for manual resolution.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../scripts/resolve-mr-conflicts.ts");
const repoRoot = resolve(import.meta.dir, "..");

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_EDITOR: "true",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  ASHLR_PM_BUN: process.execPath,
};

const dirs: string[] = [];

function git(root: string, args: string[], allowFail = false) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root, env, stdout: "pipe", stderr: "pipe",
  });
  if (!allowFail && result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result;
}

function commit(root: string, message: string) {
  git(root, ["add", "-A"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-qm", message]);
}

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function unmerged(root: string): string[] {
  return git(root, ["diff", "--name-only", "--diff-filter=U", "--"])
    .stdout.toString().split("\n").filter(Boolean);
}

/** Base tree: real .gitattributes plus files every scenario conflicts on. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mr-conflicts-"));
  dirs.push(root);
  git(root, ["init", "-qb", "main"]);
  copyFileSync(join(repoRoot, ".gitattributes"), join(root, ".gitattributes"));
  write(root, "CHANGELOG.md", "# Changelog\n\n## 1.0.0\n- initial release\n");
  write(root, "README.md", "# Fixture\n\nShared intro paragraph.\n\n## Tail\n- shared\n");
  write(root, "package.json", '{ "name": "fixture", "private": true, "dependencies": { "lp": "file:vendor/lp" } }\n');
  write(root, "vendor/lp/package.json", '{ "name": "lp", "version": "1.0.0" }\n');
  execFileSync(process.execPath, ["install", "--lockfile-only"], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
  }); // Seed a real bun.lock — bun deletes lockfiles with zero packages.
  write(root, "weird.txt", "shared line\n");
  commit(root, "base");
  return root;
}

/** Branch + main diverge on the same hunks of every fixture file. */
function diverge(root: string) {
  git(root, ["checkout", "-qb", "pr"]);
  write(root, "CHANGELOG.md", "# Changelog\n\n## 1.1.0\n- pr feature\n\n## 1.0.0\n- initial release\n");
  write(root, "README.md", "# Fixture\n\nShared intro paragraph.\n\n## PR docs\n- added by the PR\n\n## Tail\n- shared\n");
  write(root, "CLAUDE.md", "rules added by the PR\n");
  write(root, "bun.lock", read(root, "bun.lock").replace('"lp": "file:vendor/lp"', '"lp": "file:vendor/lp#pr"'));
  write(root, "weird.txt", "pr line\n");
  commit(root, "pr changes");
  git(root, ["checkout", "-q", "main"]);
  write(root, "CHANGELOG.md", "# Changelog\n\n## 1.2.0\n- main hotfix\n\n## 1.0.0\n- initial release\n");
  write(root, "README.md", "# Fixture\n\nShared intro paragraph.\n\n## Main docs\n- added on main\n\n## Tail\n- shared\n");
  write(root, "CLAUDE.md", "rules added on main\n");
  write(root, "bun.lock", read(root, "bun.lock").replace('"lp": "file:vendor/lp"', '"lp": "file:vendor/lp#main"'));
  write(root, "weird.txt", "main line\n");
  commit(root, "main changes");
  git(root, ["checkout", "-q", "pr"]);
}

function runHelper(root: string, args: string[] = []) {
  return Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    cwd: root, env, stdout: "pipe", stderr: "pipe",
  });
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("resolve-mr-conflicts", () => {
  test("union driver rebases a CHANGELOG conflict cleanly, no model call", () => {
    const root = fixture();
    git(root, ["checkout", "-qb", "pr"]);
    write(root, "CHANGELOG.md", "# Changelog\n\n## 1.1.0\n- pr feature\n\n## 1.0.0\n- initial release\n");
    commit(root, "pr changelog");
    git(root, ["checkout", "-q", "main"]);
    write(root, "CHANGELOG.md", "# Changelog\n\n## 1.2.0\n- main hotfix\n\n## 1.0.0\n- initial release\n");
    commit(root, "main changelog");
    git(root, ["checkout", "-q", "pr"]);

    const rebase = git(root, ["-c", "commit.gpgsign=false", "rebase", "main"], true);
    expect(rebase.exitCode).toBe(0);
    expect(unmerged(root)).toEqual([]);

    const changelog = read(root, "CHANGELOG.md");
    expect(changelog).not.toContain("<<<<<<<");
    expect(changelog).toContain("- pr feature");
    expect(changelog).toContain("- main hotfix");
  });

  test("helper resolves docs by union, regenerates the lockfile, reports the unknown", () => {
    const root = fixture();
    diverge(root);

    const rebase = git(root, ["-c", "commit.gpgsign=false", "rebase", "main"], true);
    expect(rebase.exitCode).not.toBe(0);
    // merge=union resolved CHANGELOG.md before the rebase stopped.
    expect(unmerged(root).sort()).toEqual(["CLAUDE.md", "README.md", "bun.lock", "weird.txt"]);
    const changelog = read(root, "CHANGELOG.md");
    expect(changelog).not.toContain("<<<<<<<");
    expect(changelog).toContain("- pr feature");
    expect(changelog).toContain("- main hotfix");

    const helper = runHelper(root);
    expect(helper.exitCode).toBe(1);
    expect(helper.stdout.toString().split("\n").filter(Boolean).sort())
      .toEqual(["CLAUDE.md", "README.md", "bun.lock"]);
    expect(helper.stderr.toString()).toContain("weird.txt");
    expect(unmerged(root)).toEqual(["weird.txt"]);

    // README.md: main's version kept, the PR's own hunk re-applied.
    const readme = read(root, "README.md");
    expect(readme).not.toContain("<<<<<<<");
    expect(readme).toContain("## Main docs");
    expect(readme).toContain("## PR docs");

    // CLAUDE.md: add/add — union keeps both sides.
    const claude = read(root, "CLAUDE.md");
    expect(claude).not.toContain("<<<<<<<");
    expect(claude).toContain("rules added on main");
    expect(claude).toContain("rules added by the PR");

    // bun.lock: regenerated by bun install — the hand-edited spec is rewritten
    // back to what package.json declares, which no hand-merge would produce.
    const lock = read(root, "bun.lock");
    expect(lock).not.toContain("<<<<<<<");
    expect(lock).toContain('"lp": "file:vendor/lp",');
    expect(lock).not.toContain("file:vendor/lp#");

    // Unknown conflict still needs a human; finish the rebase deterministically.
    git(root, ["checkout", "--theirs", "--", "weird.txt"]);
    git(root, ["add", "--", "weird.txt"]);
    const cont = git(root, ["-c", "commit.gpgsign=false", "rebase", "--continue"], true);
    expect(cont.exitCode).toBe(0);
    expect(read(root, "weird.txt")).toBe("pr line\n");
    const log = git(root, ["log", "--format=%s", "-3"]).stdout.toString().trim().split("\n");
    expect(log).toEqual(["pr changes", "main changes", "base"]);
  });
});
