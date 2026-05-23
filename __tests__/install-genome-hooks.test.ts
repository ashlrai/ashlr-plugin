/**
 * Tests for scripts/install-genome-hooks.ts — the post-commit hook installer.
 *
 * Idempotency is the key property: installing twice must not duplicate or
 * corrupt the existing user hook. We also verify that an existing hook is
 * preserved when we chain our shim in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  HOOK_MARKER_BEGIN,
  HOOK_MARKER_END,
  findHooksDir,
  installPostCommitHook,
  renderHookBlock,
} from "../scripts/install-genome-hooks";

// ---------------------------------------------------------------------------
// Fixture: fresh git repo
// ---------------------------------------------------------------------------

let repoDir: string;

function initRepo(): void {
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  // Configure a no-op user so `git commit` works in deeper tests if needed.
  execFileSync("git", ["config", "user.email", "test@test.test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir });
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "ashlr-hook-install-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// findHooksDir
// ---------------------------------------------------------------------------

describe("findHooksDir", () => {
  test("returns .git/hooks for a vanilla repo", () => {
    initRepo();
    const hooks = findHooksDir(repoDir);
    expect(hooks).not.toBeNull();
    expect(hooks).toContain(".git");
    expect(hooks!.endsWith("hooks")).toBe(true);
  });

  test("returns null when not a git repo", () => {
    expect(findHooksDir(repoDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderHookBlock
// ---------------------------------------------------------------------------

describe("renderHookBlock", () => {
  test("includes markers and bun invocation", () => {
    const block = renderHookBlock("/repo", "/repo/scripts/genome-commit-watcher.ts");
    expect(block).toContain(HOOK_MARKER_BEGIN);
    expect(block).toContain(HOOK_MARKER_END);
    expect(block).toContain("bun run");
    expect(block).toContain("scripts/genome-commit-watcher.ts");
  });
});

// ---------------------------------------------------------------------------
// installPostCommitHook
// ---------------------------------------------------------------------------

describe("installPostCommitHook", () => {
  test("creates a fresh post-commit hook in a clean repo", () => {
    initRepo();
    const result = installPostCommitHook({ cwd: repoDir, force: false });
    expect(result.installed).toBe(true);
    expect(existsSync(result.hookPath!)).toBe(true);
    const content = readFileSync(result.hookPath!, "utf-8");
    expect(content).toContain("#!/usr/bin/env bash");
    expect(content).toContain(HOOK_MARKER_BEGIN);
    expect(content).toContain(HOOK_MARKER_END);
  });

  test("is idempotent — running twice does not duplicate the marker block", () => {
    initRepo();
    const first = installPostCommitHook({ cwd: repoDir, force: false });
    expect(first.installed).toBe(true);
    const firstContent = readFileSync(first.hookPath!, "utf-8");

    const second = installPostCommitHook({ cwd: repoDir, force: false });
    expect(second.installed).toBe(false);
    expect(second.reason).toBe("already-installed");
    const secondContent = readFileSync(first.hookPath!, "utf-8");
    expect(secondContent).toBe(firstContent);

    // Single marker pair, not two.
    const beginCount = (secondContent.match(new RegExp(HOOK_MARKER_BEGIN, "g")) || []).length;
    expect(beginCount).toBe(1);
  });

  test("chains onto an existing user post-commit hook without overwriting", () => {
    initRepo();
    const hookPath = join(repoDir, ".git", "hooks", "post-commit");
    const userHook = "#!/usr/bin/env bash\n# my custom logic\necho hi\n";
    writeFileSync(hookPath, userHook, "utf-8");
    chmodSync(hookPath, 0o755);

    const result = installPostCommitHook({ cwd: repoDir, force: false });
    expect(result.installed).toBe(true);
    const content = readFileSync(hookPath, "utf-8");
    expect(content.startsWith(userHook)).toBe(true);
    expect(content).toContain(HOOK_MARKER_BEGIN);
    expect(content).toContain("echo hi"); // user logic preserved
  });

  test("--force replaces the existing marker block but keeps surrounding user logic", () => {
    initRepo();
    const hookPath = join(repoDir, ".git", "hooks", "post-commit");

    const userHead = "#!/usr/bin/env bash\necho 'before-shim'\n";
    const userTail = "\necho 'after-shim'\n";
    writeFileSync(hookPath, userHead, "utf-8");

    const first = installPostCommitHook({ cwd: repoDir, force: false });
    expect(first.installed).toBe(true);
    // Append user tail AFTER the shim so we can verify it survives a re-install.
    writeFileSync(hookPath, readFileSync(hookPath, "utf-8") + userTail, "utf-8");

    const second = installPostCommitHook({ cwd: repoDir, force: true });
    expect(second.installed).toBe(true);
    const content = readFileSync(hookPath, "utf-8");
    expect(content).toContain("before-shim");
    expect(content).toContain("after-shim");
    // Exactly one marker pair remains.
    const beginCount = (content.match(new RegExp(HOOK_MARKER_BEGIN, "g")) || []).length;
    expect(beginCount).toBe(1);
  });

  test("returns no-git when cwd is not a git repo", () => {
    const result = installPostCommitHook({ cwd: repoDir, force: false });
    expect(result.installed).toBe(false);
    expect(result.reason).toBe("no-git");
  });
});
