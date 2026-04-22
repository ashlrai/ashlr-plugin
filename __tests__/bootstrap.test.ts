/**
 * bootstrap.test.ts — behavioral tests for scripts/bootstrap.mjs.
 *
 * The shim is invoked by Claude Code as the MCP server's entrypoint; its job
 * is to make sure `bun` is available before handing off. Rather than mock the
 * network-calling installer, we exercise the observable contract: when bun is
 * unreachable AND the user has opted out of auto-install, the bootstrap must
 * exit 1 with a message pointing at manual-install docs.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const BOOTSTRAP = resolve(import.meta.dir, "..", "scripts", "bootstrap.mjs");

let SANDBOX_HOME: string;

beforeAll(() => {
  SANDBOX_HOME = mkdtempSync(join(tmpdir(), "ashlr-bootstrap-"));
});

afterAll(() => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch { /* ok */ }
});

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
});
