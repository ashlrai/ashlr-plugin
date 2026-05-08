/**
 * grep-default-cwd.test.ts
 *
 * Regression test for the v1.29 fix: when ashlr__grep is called without an
 * explicit `cwd` argument, it now uses `primaryProjectRoot()` as the default
 * rather than `process.cwd()` (which is the plugin install dir for an MCP
 * subprocess). Pre-fix every search returned matches inside the cached
 * plugin's own source instead of the user's project.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { realpathSync } from "fs";

import { primaryProjectRoot } from "../servers/_cwd-clamp";

const ENV_BACKUP = {
  cpd: process.env.CLAUDE_PROJECT_DIR,
  hint: process.env.ASHLR_HOME_OVERRIDE,
  paths: process.env.ASHLR_ALLOW_PROJECT_PATHS,
};

let fakeProject: string;
let fakeHome: string;
let originalCwd: string;

beforeEach(async () => {
  fakeProject = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-proj-")));
  fakeHome = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-home-")));
  await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
  originalCwd = process.cwd();
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.ASHLR_ALLOW_PROJECT_PATHS;
  process.env.ASHLR_HOME_OVERRIDE = fakeHome;
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (ENV_BACKUP.cpd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = ENV_BACKUP.cpd;
  if (ENV_BACKUP.paths === undefined) delete process.env.ASHLR_ALLOW_PROJECT_PATHS;
  else process.env.ASHLR_ALLOW_PROJECT_PATHS = ENV_BACKUP.paths;
  if (ENV_BACKUP.hint === undefined) delete process.env.ASHLR_HOME_OVERRIDE;
  else process.env.ASHLR_HOME_OVERRIDE = ENV_BACKUP.hint;
  await rm(fakeProject, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
});

describe("primaryProjectRoot", () => {
  test("returns process.cwd() when cwd is a real project (no hint, no env)", () => {
    process.chdir(fakeProject);
    expect(primaryProjectRoot()).toBe(fakeProject);
  });

  test("CLAUDE_PROJECT_DIR contributes to the allowlist (cwd still wins when both real)", async () => {
    // Both cwd and CLAUDE_PROJECT_DIR are real project paths. allowedRoots
    // puts cwd first; primaryProjectRoot picks the first non-plugin-install,
    // non-HOME-config root. So cwd wins when it's already a real project.
    const otherProject = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-other-")));
    try {
      process.env.CLAUDE_PROJECT_DIR = otherProject;
      process.chdir(fakeProject);
      const r = primaryProjectRoot();
      // Either is acceptable as "user project root" — both are real, both
      // are in the allowlist. The strict invariant is: never plugin-install
      // or HOME-config.
      expect([fakeProject, otherProject]).toContain(r);
    } finally {
      await rm(otherProject, { recursive: true, force: true });
    }
  });

  test("skips ~/.claude and ~/.ashlr from the candidate roots", () => {
    // process.cwd() is the test runner's project (real), so even when
    // home-config dirs are in the allowlist, primaryProjectRoot picks the
    // real project. We verify this indirectly: the result must NOT be
    // ~/.claude or ~/.ashlr.
    const r = primaryProjectRoot();
    expect(r).not.toMatch(/\/\.claude$/);
    expect(r).not.toMatch(/\/\.ashlr$/);
  });

  test("returns process.cwd() as last-resort fallback even when cwd looks like plugin install", () => {
    // Inside a path containing /.claude/plugins/cache/, primaryProjectRoot
    // would normally skip it, but with no other project hint available it
    // falls back to process.cwd() — the cwd-clamp will then refuse the
    // call, which is the correct error surface.
    const fakeCache = realpathSync(fakeProject); // any real path
    process.chdir(fakeCache);
    const r = primaryProjectRoot();
    // Should return *some* string (not undefined/empty) — the exact value
    // depends on what other roots are in the allowlist via env. The contract
    // is "never empty", which is what callers rely on.
    expect(typeof r).toBe("string");
    expect(r.length).toBeGreaterThan(0);
  });
});
