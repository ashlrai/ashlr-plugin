/**
 * bootstrap.test.ts — behavioral tests for scripts/bootstrap.mjs.
 *
 * The shim is invoked by Claude Code as the MCP server's entrypoint; its job
 * is to make sure `bun` is available before handing off. Rather than mock the
 * network-calling installer, we exercise the observable contract by pointing
 * PATH at tiny shell stubs we control.
 *
 * Coverage:
 *   - ASHLR_NO_AUTO_INSTALL=1 + no bun         -> exit 1, manual-install msg
 *   - happy path: bun already on PATH          -> forwards args to bun run
 *   - installer script itself exits non-zero   -> exit 1, "installer failed"
 *   - installer succeeds but bun still absent  -> exit 1, "still not visible"
 *
 * Stub-based tests are POSIX-only. Windows uses powershell; that path is
 * smoke-tested via scripts/smoke-cross-platform.ts + CI matrix.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const BOOTSTRAP = resolve(import.meta.dir, "..", "scripts", "bootstrap.mjs");

let SANDBOX_HOME: string;
let STUB_ROOT: string;

beforeAll(() => {
  SANDBOX_HOME = mkdtempSync(join(tmpdir(), "ashlr-bootstrap-"));
  STUB_ROOT = mkdtempSync(join(tmpdir(), "ashlr-bootstrap-stubs-"));
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

// POSIX-only: stubbing `bash` + `bun` via shell scripts doesn't translate to
// Windows .cmd/.exe shims cleanly, and the powershell branch is smoke-tested
// elsewhere.
const posix = process.platform === "win32" ? it.skip : it;

describe("scripts/bootstrap.mjs", () => {
  it("refuses to auto-install when ASHLR_NO_AUTO_INSTALL=1 and bun is unreachable", () => {
    // Empty PATH + $HOME pointing at a bun-less temp dir => hasBun() and
    // prependBunToPath() both fail, forcing autoInstallBun(), which should
    // honor the opt-out flag.
    const result = spawnSync(process.execPath, [BOOTSTRAP, "noop.ts"], {
      encoding: "utf8",
      env: {
        PATH: "",
        HOME: SANDBOX_HOME,
        USERPROFILE: SANDBOX_HOME,
        ASHLR_NO_AUTO_INSTALL: "1",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ASHLR_NO_AUTO_INSTALL=1");
    expect(result.stderr).toContain("https://bun.sh");
  });

  posix("happy path: forwards args to bun when bun is already on PATH", () => {
    const recordPath = join(STUB_ROOT, "happy-record.txt");
    const bunDir = join(STUB_ROOT, "happy-bin");
    writeStub(
      bunDir,
      "bun",
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "1.0.0-stub"; exit 0; fi',
        `printf '%s\\n' "$@" > "${recordPath}"`,
        "exit 0",
        "",
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, [BOOTSTRAP, "marker-arg"], {
      encoding: "utf8",
      env: {
        PATH: bunDir,
        HOME: SANDBOX_HOME,
        USERPROFILE: SANDBOX_HOME,
      },
    });
    expect(result.status).toBe(0);
    const recorded = readFileSync(recordPath, "utf8").split("\n").filter(Boolean);
    expect(recorded[0]).toBe("run");
    expect(recorded[1]).toContain("mcp-entrypoint.ts");
    expect(recorded[2]).toBe("marker-arg");
  });

  posix("exits 1 when the installer script itself fails", () => {
    // PATH holds only a `bash` that always exits 1. bun is unreachable, so
    // autoInstallBun fires, invokes bash, bash exits 1, bootstrap exits 1.
    const failDir = join(STUB_ROOT, "fail-bin");
    writeStub(
      failDir,
      "bash",
      ["#!/bin/sh", "exit 1", ""].join("\n"),
    );
    const result = spawnSync(process.execPath, [BOOTSTRAP, "noop.ts"], {
      encoding: "utf8",
      env: {
        PATH: failDir,
        HOME: SANDBOX_HOME,
        USERPROFILE: SANDBOX_HOME,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installer failed");
  });

  posix("exits 1 when the installer succeeds but bun still isn't on PATH", () => {
    // Bash stub exits 0 (installer "succeeded") but installs nothing. The
    // post-install hasBun() check should catch this and bail with the
    // open-a-new-terminal hint.
    const noopDir = join(STUB_ROOT, "noop-bin");
    writeStub(
      noopDir,
      "bash",
      ["#!/bin/sh", "exit 0", ""].join("\n"),
    );
    const result = spawnSync(process.execPath, [BOOTSTRAP, "noop.ts"], {
      encoding: "utf8",
      env: {
        PATH: noopDir,
        HOME: SANDBOX_HOME,
        USERPROFILE: SANDBOX_HOME,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("still not visible");
  });
});
