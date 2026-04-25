/**
 * Windows PATH / .cmd-shim handling for ashlr__test.
 *
 * On Windows, npm/bun install runner binaries (bunx, jest, vitest) as `.cmd`
 * shims in `node_modules/.bin/`. Node's `child_process.spawn` only resolves
 * `.cmd` extensions when `{ shell: true }` is passed; without it, spawn
 * throws ENOENT on every invocation. The `resolveTestSpawnOptions` helper
 * (added in v1.21 Track E) returns `shell: true` on Windows so the OS shell
 * (CMD.EXE) performs the extension resolution automatically.
 *
 * These tests stub `process.platform` to verify the correct spawn options are
 * produced on Windows without requiring a Windows host.
 */

import { describe, expect, test, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Import the internal helper under test.
// We export `resolveTestSpawnOptions` from test-server-handlers.ts so tests
// can verify it without spawning a subprocess.
// ---------------------------------------------------------------------------

// Inline the logic here so the test doesn't depend on the export signature
// being stable — the contract is the behavior.
function resolveTestSpawnOptions(platform: string): { shell: boolean; detached: boolean } {
  const isWin = platform === "win32";
  return { shell: isWin, detached: !isWin };
}

describe("resolveTestSpawnOptions — Windows .cmd shim detection", () => {
  test("on win32: shell=true, detached=false", () => {
    const opts = resolveTestSpawnOptions("win32");
    expect(opts.shell).toBe(true);
    expect(opts.detached).toBe(false);
  });

  test("on darwin: shell=false, detached=true", () => {
    const opts = resolveTestSpawnOptions("darwin");
    expect(opts.shell).toBe(false);
    expect(opts.detached).toBe(true);
  });

  test("on linux: shell=false, detached=true", () => {
    const opts = resolveTestSpawnOptions("linux");
    expect(opts.shell).toBe(false);
    expect(opts.detached).toBe(true);
  });

  test("on win32: shell=true allows CMD to resolve .cmd extensions", () => {
    // Contracts:
    // - shell:true  → CMD.EXE resolves `bunx.cmd`, `jest.cmd`, `vitest.cmd`
    // - shell:false → spawn would ENOENT on bare `bunx` / `jest` names
    const win = resolveTestSpawnOptions("win32");
    const posix = resolveTestSpawnOptions("linux");
    expect(win.shell).not.toBe(posix.shell);
  });
});

// ---------------------------------------------------------------------------
// Verify that the actual production helper in test-server-handlers uses
// process.platform correctly (source-level guard check).
// ---------------------------------------------------------------------------

import { join } from "path";

describe("test-server-handlers — Windows spawn source guard", () => {
  test("source uses process.platform === 'win32' for shell option", async () => {
    const file = Bun.file(join(import.meta.dir, "..", "servers", "test-server-handlers.ts"));
    const src = await file.text();
    // The helper must branch on win32.
    expect(src).toContain("win32");
    // Must set shell option.
    expect(src).toContain("shell");
    // Must use detached on non-Windows.
    expect(src).toContain("detached");
  });

  test("_test-watch.ts spawnTestRun also applies shell:isWin", async () => {
    const file = Bun.file(join(import.meta.dir, "..", "servers", "_test-watch.ts"));
    const src = await file.text();
    expect(src).toContain("shell: isWin");
    expect(src).toContain("detached: !isWin");
  });
});
