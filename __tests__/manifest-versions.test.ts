/**
 * manifest-versions.test.ts — Assert that .claude-plugin/plugin.json and
 * .codex-plugin/plugin.json each declare the same version as root
 * package.json.  If they drift, CI fails hard and the agent is pointed
 * at the exact mismatch.  No other file is changed.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

function readJson<T = Record<string, unknown>>(relativePath: string): T {
  return JSON.parse(
    readFileSync(join(ROOT, relativePath), "utf-8"),
  ) as T;
}

// -----------------------------------------------------------------------
// Manifest-versions checks
// -----------------------------------------------------------------------

describe("manifest-versions", () => {
  test("root package.json version is non-empty", () => {
    const pkg = readJson<{ version: string }>("package.json");
    expect(pkg.version?.length).toBeGreaterThan(0);
  });

  test(".claude-plugin/plugin.json version equals package.json version", () => {
    const pkg = readJson<{ version: string }>("package.json");
    const manifest = readJson<{ version: string }>(
      ".claude-plugin/plugin.json",
    );
    expect(manifest.version).toBe(pkg.version);
  });

  test(".codex-plugin/plugin.json version equals package.json version", () => {
    const pkg = readJson<{ version: string }>("package.json");
    const manifest = readJson<{ version: string }>(
      ".codex-plugin/plugin.json",
    );
    expect(manifest.version).toBe(pkg.version);
  });
});
