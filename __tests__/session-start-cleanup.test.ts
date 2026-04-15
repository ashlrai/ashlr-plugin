/**
 * Tests for cleanupStalePluginVersions — the post-upgrade hygiene pass that
 * removes sibling versioned cache directories so ~/.claude/plugins/cache
 * doesn't grow unboundedly across plugin upgrades.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { cleanupStalePluginVersions } from "../hooks/session-start";

let root: string;
let parent: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ashlr-cleanup-"));
  parent = join(root, ".claude", "plugins", "cache", "ashlr-marketplace", "ashlr");
  mkdirSync(parent, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function seed(name: string): string {
  const p = join(parent, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "sentinel.txt"), "x");
  return p;
}

describe("cleanupStalePluginVersions", () => {
  test("removes stale siblings, keeps current version", () => {
    const v060 = seed("0.6.0");
    seed("0.4.0");
    seed("0.5.0");

    const logs: string[] = [];
    const res = cleanupStalePluginVersions(v060, { logger: (m) => logs.push(m) });

    expect(existsSync(v060)).toBe(true);
    expect(existsSync(join(parent, "0.4.0"))).toBe(false);
    expect(existsSync(join(parent, "0.5.0"))).toBe(false);
    expect(res.removed.sort()).toEqual(["0.4.0", "0.5.0"]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("cleaned 2 stale cache version(s)");
    expect(logs[0]).toContain("0.4.0");
    expect(logs[0]).toContain("0.5.0");
  });

  test("$CLAUDE_PLUGIN_ROOT unset → no cleanup attempted", () => {
    seed("0.5.0");
    const res = cleanupStalePluginVersions(undefined, { logger: () => {} });
    expect(res.removed).toEqual([]);
    expect(existsSync(join(parent, "0.5.0"))).toBe(true);
  });

  test("non-semver siblings (e.g. 'latest') are not touched", () => {
    const v060 = seed("0.6.0");
    seed("latest");
    seed("0.4.0");
    seed("dev-branch");

    const res = cleanupStalePluginVersions(v060, { logger: () => {} });

    expect(existsSync(v060)).toBe(true);
    expect(existsSync(join(parent, "latest"))).toBe(true);
    expect(existsSync(join(parent, "dev-branch"))).toBe(true);
    expect(existsSync(join(parent, "0.4.0"))).toBe(false);
    expect(res.removed).toEqual(["0.4.0"]);
  });

  test("CLAUDE_PLUGIN_ROOT with unexpected shape → do nothing (safety)", () => {
    seed("0.4.0");
    const weird = seed("latest"); // basename is not semver
    const res = cleanupStalePluginVersions(weird, { logger: () => {} });
    expect(res.removed).toEqual([]);
    expect(res.reason).toBe("unexpected-shape");
    expect(existsSync(join(parent, "0.4.0"))).toBe(true);
  });

  test("trailing slash on plugin root is tolerated", () => {
    const v060 = seed("0.6.0");
    seed("0.5.0");
    const res = cleanupStalePluginVersions(v060 + "/", { logger: () => {} });
    expect(res.removed).toEqual(["0.5.0"]);
    expect(existsSync(v060)).toBe(true);
  });

  test("no siblings to clean → empty removed list, no log", () => {
    const v060 = seed("0.6.0");
    const logs: string[] = [];
    const res = cleanupStalePluginVersions(v060, { logger: (m) => logs.push(m) });
    expect(res.removed).toEqual([]);
    expect(logs).toEqual([]);
  });
});
