#!/usr/bin/env node
/**
 * hook-bootstrap.mjs — node trampoline for every hook in hooks/hooks.json.
 *
 * Mirror of scripts/bootstrap.mjs but for the Claude Code hooks surface.
 * Claude Code spawns hook commands with its *own* parent-process PATH, which
 * doesn't include ~/.bun/bin right after a first-run auto-install. Without
 * this trampoline, every hook silently dies with "bun: not found" until the
 * user restarts Claude Code.
 *
 * Flow:
 *   1. If bun is already on PATH: spawn it directly.
 *   2. Otherwise, try prepending ~/.bun/bin (populated by a prior
 *      bootstrap.mjs auto-install from the MCP server spawn).
 *   3. If bun is STILL unreachable: exit 0 silently. Hooks are decoration,
 *      never a gate on the harness — a missing bun here just means the hook
 *      no-ops for this session, not that the user's workflow breaks.
 *
 * Critical: this trampoline NEVER auto-installs bun. Hooks fire concurrently
 * (multiple PreToolUse + PostToolUse in parallel); racing installers would
 * be catastrophic. Only scripts/bootstrap.mjs (MCP server spawn — single
 * producer) is allowed to trigger the installer.
 *
 * ASHLR_NO_AUTO_INSTALL only gates *installation*; PATH *resolution* always
 * runs — we never refuse to look at a bin dir the user already has on disk.
 *
 * Usage (wired from hooks/hooks.json):
 *   node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-bootstrap.mjs" \
 *        "${CLAUDE_PLUGIN_ROOT}/hooks/<hook>.ts" [args...]
 */

import { spawnSync } from "node:child_process";
import { hasBun, prependBunToPath } from "./bun-resolve.mjs";

const hookPath = process.argv[2];
if (!hookPath) {
  process.stderr.write("[ashlr:hook-bootstrap] missing hook path argument\n");
  process.exit(0); // still don't gate the harness
}

if (!hasBun()) {
  prependBunToPath();
  if (!hasBun()) {
    // Bun genuinely unreachable. Exit 0 — hooks must never fail the harness.
    // The MCP server's bootstrap.mjs will install bun on its next spawn if it
    // hasn't already; this hook simply no-ops for now.
    process.exit(0);
  }
}

const forwarded = process.argv.slice(3);
const result = spawnSync("bun", ["run", hookPath, ...forwarded], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  process.stderr.write(`[ashlr:hook-bootstrap] ${result.error.message}\n`);
  process.exit(0);
}
process.exit(result.status ?? 0);
