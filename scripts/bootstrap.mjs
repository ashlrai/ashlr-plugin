#!/usr/bin/env node
/**
 * bootstrap.mjs — node-level trampoline that ensures bun is available
 * before handing off to scripts/mcp-entrypoint.ts.
 *
 * Why a node shim? Claude Code's plugin manifest spawns a single `command`.
 * If that command is `bun` and bun isn't installed, the spawn fails before
 * any of our code runs — chicken-and-egg. Node is reliably present because
 * Claude Code itself runs on node, so we use it as the trampoline.
 *
 * Flow:
 *   1. Check for bun on PATH (`bun --version`).
 *   2. If missing, auto-install via the upstream installer (unless
 *      ASHLR_NO_AUTO_INSTALL=1), then prepend the default bun bin dir to
 *      PATH so the current process can find it without a shell restart.
 *   3. Exec `bun run scripts/mcp-entrypoint.ts <forwarded-args>` with stdio
 *      wired through so the MCP protocol owns stdin/stdout.
 *
 * Any diagnostic output goes to stderr — stdout is reserved for MCP traffic.
 */

import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasBun, prependBunToPath } from "./bun-resolve.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = platform() === "win32";

function log(msg) {
  process.stderr.write(`[ashlr:bootstrap] ${msg}\n`);
}

function autoInstallBun() {
  if (process.env.ASHLR_NO_AUTO_INSTALL === "1") {
    log("bun not found and ASHLR_NO_AUTO_INSTALL=1 — refusing to auto-install.");
    log("install manually: https://bun.sh/docs/installation");
    process.exit(1);
  }
  log("bun not found on PATH — installing from https://bun.sh ...");
  const result = IS_WINDOWS
    ? spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "irm bun.sh/install.ps1 | iex",
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      )
    : spawnSync(
        "bash",
        ["-lc", "curl -fsSL https://bun.sh/install | bash"],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
  if (result.status !== 0) {
    log("bun installer failed. Install manually: https://bun.sh/docs/installation");
    process.exit(1);
  }
  prependBunToPath();
  if (!hasBun()) {
    log("bun installed but still not visible — open a new terminal and retry.");
    process.exit(1);
  }
  log("bun installed successfully.");
}

// --- Main ---

if (!hasBun()) {
  // Default install dir may exist from a prior install that hadn't made it
  // onto PATH yet — try it before downloading anything.
  prependBunToPath();
  if (!hasBun()) autoInstallBun();
}

const entrypoint = join(PLUGIN_ROOT, "scripts", "mcp-entrypoint.ts");
const child = spawn("bun", ["run", entrypoint, ...process.argv.slice(2)], {
  cwd: PLUGIN_ROOT,
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // Child may already be gone.
    }
  });
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
