#!/usr/bin/env node
/**
 * One-command dev setup for macOS, Windows, and Linux.
 * Safe to run again. No prompts.
 *
 *   node scripts/setup.mjs
 *
 * Finds bun without a shell, so Windows does not need PATHEXT or a .cmd shim.
 * Then installs from the lockfile and runs the tool smoke check.
 */

import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasBun, prependBunToPath, resolveBunExecutable } from "./bun-resolve.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const os = platform();

if (os !== "darwin" && os !== "win32" && os !== "linux") {
  process.stderr.write(`scripts/setup.mjs supports macOS, Windows, and Linux. This machine reports ${os}.\n`);
  process.exit(1);
}

prependBunToPath();
if (!hasBun()) {
  const hint = os === "win32"
    ? "Install it: irm bun.sh/install.ps1 | iex"
    : "Install it: curl -fsSL https://bun.sh/install | bash";
  process.stderr.write(`Bun is not on PATH or in ~/.bun/bin.\n${hint}\nThen run: node scripts/setup.mjs\n`);
  process.exit(1);
}

const bun = resolveBunExecutable();
if (!bun) {
  process.stderr.write("Bun was found earlier but could not be resolved. Open a new terminal and run: node scripts/setup.mjs\n");
  process.exit(1);
}

function run(args) {
  const result = spawnSync(bun, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["install", "--frozen-lockfile"]);
run(["run", "smoke:tools"]);
