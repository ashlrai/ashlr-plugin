/**
 * hook-bootstrap.test.ts — behavioral tests for scripts/hook-bootstrap.mjs.
 *
 * Mirrors the pattern in bootstrap.test.ts: POSIX-only shell stubs for bun
 * and the hook target. The hook trampoline's contract differs from the MCP
 * bootstrap's in two important ways:
 *
 *   1. It must NEVER install bun (install races across concurrent hooks = bad).
 *   2. It must ALWAYS exit 0 — hooks must not gate the Claude Code harness.
 *      Even "bun is genuinely missing" is exit 0 silently, not exit 1.
 *
 * Windows is covered by scripts/smoke-cross-platform.ts + CI matrix; stub
 * shell scripts don't translate cleanly to .cmd/.exe shims.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
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
import { join, resolve } from "path";

const HOOK_BOOTSTRAP = resolve(
  import.meta.dir,
  "..",
  "scripts",
  "hook-bootstrap.mjs",
);

let SANDBOX_HOME: string;
let STUB_ROOT: string;

beforeAll(() => {
  SANDBOX_HOME = mkdtempSync(join(tmpdir(), "ashlr-hook-bootstrap-"));
  STUB_ROOT = mkdtempSync(join(tmpdir(), "ashlr-hook-bootstrap-stubs-"));
});

afterAll(() => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch { /* ok */ }
  try { rmSync(STUB_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
});

function writeStub(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

/**
 * Build a bun stub that records each invocation's argv into `recordPath`
 * (one arg per line). Exits 0 after recording so the trampoline's
 * spawnSync("bun", ...) sees a successful child.
 */
function bunStub(recordPath: string): string {
  return [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "1.0.0-stub"; exit 0; fi',
    `printf '%s\\n' "$@" >> "${recordPath}"`,
    "exit 0",
    "",
  ].join("\n");
}

const posix = process.platform === "win32" ? it.skip : it;

describe("scripts/hook-bootstrap.mjs", () => {
  posix("happy path: bun on PATH — forwards to `bun run <hook>`", () => {
    const recordPath = join(STUB_ROOT, "happy-record.txt");
    const bunDir = join(STUB_ROOT, "happy-bin");
    writeStub(bunDir, "bun", bunStub(recordPath));
    const hookPath = join(STUB_ROOT, "fake-hook.ts");
    writeFileSync(hookPath, "// stub hook\n");

    const result = spawnSync(
      process.execPath,
      [HOOK_BOOTSTRAP, hookPath, "hook-arg-1"],
      {
        encoding: "utf8",
        env: {
          PATH: bunDir,
          HOME: SANDBOX_HOME,
          USERPROFILE: SANDBOX_HOME,
        },
      },
    );
    expect(result.status).toBe(0);
    const recorded = readFileSync(recordPath, "utf8").split("\n").filter(Boolean);
    expect(recorded[0]).toBe("run");
    expect(recorded[1]).toBe(hookPath);
    expect(recorded[2]).toBe("hook-arg-1");
  });

  it.skip("PATH gap recovery: bun missing from PATH but present in ~/.bun/bin", () => {
    // Fresh sandbox home so the fake ~/.bun/bin/bun is all we've got.
    const sandbox = mkdtempSync(join(tmpdir(), "ashlr-hook-recovery-"));
    const bunBinDir = join(sandbox, ".bun", "bin");
    const recordPath = join(STUB_ROOT, "recovery-record.txt");
    writeStub(bunBinDir, "bun", bunStub(recordPath));
    const hookPath = join(STUB_ROOT, "fake-hook.ts");
    writeFileSync(hookPath, "// stub hook\n");

    const result = spawnSync(
      process.execPath,
      [HOOK_BOOTSTRAP, hookPath],
      {
        encoding: "utf8",
        env: {
          // Empty PATH so the first hasBun() fails and forces prependBunToPath().
          PATH: "",
          HOME: sandbox,
          USERPROFILE: sandbox,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(existsSync(recordPath)).toBe(true);
    const recorded = readFileSync(recordPath, "utf8").split("\n").filter(Boolean);
    expect(recorded[0]).toBe("run");
    expect(recorded[1]).toBe(hookPath);

    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ok */ }
  });

  posix("bun truly missing: exits 0 silently and does NOT attempt install", () => {
    // PATH is empty and ~/.bun/bin does not exist. The trampoline must exit 0
    // without invoking any bash/powershell installer (hooks never install).
    const sandbox = mkdtempSync(join(tmpdir(), "ashlr-hook-missing-"));
    const installerCanary = join(STUB_ROOT, "installer-canary.txt");

    // Place a bash stub on PATH that writes to the canary if invoked —
    // proving the trampoline did NOT try to shell out to the bun installer.
    const trapDir = join(STUB_ROOT, "trap-bin");
    writeStub(
      trapDir,
      "bash",
      ["#!/bin/sh", `echo "invoked" > "${installerCanary}"`, "exit 0", ""].join("\n"),
    );

    const hookPath = join(STUB_ROOT, "fake-hook.ts");
    writeFileSync(hookPath, "// stub hook\n");

    const result = spawnSync(
      process.execPath,
      [HOOK_BOOTSTRAP, hookPath],
      {
        encoding: "utf8",
        env: {
          PATH: trapDir, // only bash is here, no bun
          HOME: sandbox,
          USERPROFILE: sandbox,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(existsSync(installerCanary)).toBe(false);

    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it.skip("ASHLR_NO_AUTO_INSTALL=1 does not block PATH resolution", () => {
    // The opt-out flag only gates installation; the trampoline should still
    // probe ~/.bun/bin and route the hook through it.
    const sandbox = mkdtempSync(join(tmpdir(), "ashlr-hook-noinstall-"));
    const bunBinDir = join(sandbox, ".bun", "bin");
    const recordPath = join(STUB_ROOT, "noinstall-record.txt");
    writeStub(bunBinDir, "bun", bunStub(recordPath));
    const hookPath = join(STUB_ROOT, "fake-hook.ts");
    writeFileSync(hookPath, "// stub hook\n");

    const result = spawnSync(
      process.execPath,
      [HOOK_BOOTSTRAP, hookPath],
      {
        encoding: "utf8",
        env: {
          PATH: "",
          HOME: sandbox,
          USERPROFILE: sandbox,
          ASHLR_NO_AUTO_INSTALL: "1",
        },
      },
    );
    expect(result.status).toBe(0);
    const recorded = readFileSync(recordPath, "utf8").split("\n").filter(Boolean);
    expect(recorded[0]).toBe("run");
    expect(recorded[1]).toBe(hookPath);

    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ok */ }
  });

  posix("missing hook path argument exits 0 (never gates the harness)", () => {
    const result = spawnSync(process.execPath, [HOOK_BOOTSTRAP], {
      encoding: "utf8",
      env: { PATH: "", HOME: SANDBOX_HOME, USERPROFILE: SANDBOX_HOME },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("missing hook path argument");
  });
});
