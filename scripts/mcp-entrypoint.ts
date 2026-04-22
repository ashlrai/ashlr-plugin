#!/usr/bin/env bun
/**
 * Bun-native MCP server entrypoint. Replaces `scripts/mcp-entrypoint.sh`
 * so the plugin works on Windows without Git Bash.
 *
 * Responsibilities (in order):
 *   1. Resolve PLUGIN_ROOT from __dirname (never trust cwd).
 *   2. Self-install deps if `node_modules/@modelcontextprotocol/sdk` is missing.
 *   3. Opportunistically drop stale sibling versioned cache dirs.
 *   4. Forward CLAUDE_SESSION_ID so savings bucket to the right session.
 *   5. Spawn `bun run <server.ts>` as a child and forward stdio 1:1 so the
 *      MCP protocol continues to own stdin/stdout/stderr.
 *
 * Why not `await import()` the server directly? Bun would share the import
 * cache with this bootstrapping module, which subtly breaks servers that
 * assume they own `process.argv` or call `process.exit`. A dedicated child
 * keeps the MCP process cleanly isolated.
 *
 * Usage (in .claude-plugin/plugin.json mcpServers entries):
 *   "command": "bun",
 *   "args": ["run", "${CLAUDE_PLUGIN_ROOT}/scripts/mcp-entrypoint.ts", "servers/_router.ts"]
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(__filename), "..");
process.chdir(PLUGIN_ROOT);

// 1. Self-install deps if missing. Idempotent — `bun install` is a no-op once
//    node_modules is populated.
const sdkMarker = resolve(PLUGIN_ROOT, "node_modules", "@modelcontextprotocol", "sdk");
if (!existsSync(sdkMarker)) {
  console.error(`[ashlr] first-run: installing dependencies in ${PLUGIN_ROOT}`);
  const result = Bun.spawnSync(["bun", "install", "--silent"], {
    cwd: PLUGIN_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (!result.success) {
    console.error(`[ashlr] bun install failed. Ensure bun is on PATH and network is available.`);
    console.error(`[ashlr] Manual fix: cd "${PLUGIN_ROOT}" && bun install`);
    process.exit(1);
  }
}

// 2. Opportunistically drop stale sibling version caches. Safe: strict semver
//    guard + skip current dir. Non-version dirs (latest, dev-branch) survive.
//    Handles both Unix and Windows path separators for the "plugins/cache"
//    marker so it fires correctly inside %USERPROFILE%\.claude\plugins\cache\.
const currentVersion = basename(PLUGIN_ROOT);
const parent = dirname(PLUGIN_ROOT);
const SEMVER = /^\d+\.\d+\.\d+$/;
const inCacheDir =
  parent.includes(`${resolve("/").slice(0, 1)}plugins${resolve("/").slice(0, 1)}cache`) ||
  parent.includes("/plugins/cache/") ||
  parent.includes("\\plugins\\cache\\");
if (SEMVER.test(currentVersion) && existsSync(parent) && inCacheDir) {
  try {
    for (const sib of readdirSync(parent)) {
      if (!SEMVER.test(sib) || sib === currentVersion) continue;
      const sibPath = resolve(parent, sib);
      try {
        if (statSync(sibPath).isDirectory()) {
          rmSync(sibPath, { recursive: true, force: true });
          console.error(`[ashlr] removed stale cache: ${sib}`);
        }
      } catch {
        // Best-effort — if a rm fails (permissions, busy files on Windows),
        // skip it. The cache still works; just keeps a bit of extra disk.
      }
    }
  } catch {
    // readdirSync of the parent failed — not fatal; proceed.
  }
}

// 3. Forward Claude Code's session id so MCP servers attribute savings to the
//    correct per-session bucket in ~/.ashlr/stats.json. Without this, the
//    status-line "session +N" number gets clobbered across concurrent
//    terminals. Mirror under ASHLR_SESSION_ID for subprocesses to read.
if (process.env["CLAUDE_SESSION_ID"]) {
  process.env["ASHLR_SESSION_ID"] = process.env["CLAUDE_SESSION_ID"];
}

// 4. Exec the requested server script. Any remaining argv are passed through
//    to `bun run <script> [...args]`, preserving compatibility with the bash
//    entrypoint's `exec bun run "$@"` behavior.
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(`[ashlr] usage: mcp-entrypoint.ts <server.ts> [...args]`);
  process.exit(1);
}

const child = Bun.spawn(["bun", "run", ...args], {
  cwd: PLUGIN_ROOT,
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});

// Propagate SIGINT/SIGTERM so a plugin reload or shutdown cleans up cleanly.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // Child may already be gone; ignore.
    }
  });
}

const exitCode = await child.exited;
process.exit(exitCode);
