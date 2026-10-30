#!/usr/bin/env node
/**
 * ashlr-plugin package bin — node launcher for scripts/cli.ts.
 *
 * npm installs this as `ashlr-plugin`. The CLI itself runs under bun; this
 * shim finds bun (PATH, then ~/.bun/bin) and otherwise explains how to get it,
 * instead of failing with `/usr/bin/env: 'bun': No such file or directory`.
 * It never installs anything.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasBun, prependBunToPath, resolveBunExecutable } from "./bun-resolve.mjs";
import { buildHandshake, wantsHandshake } from "./handshake.mjs";

if (!hasBun()) prependBunToPath();

// Companion handshake (docs/ashlr-handshake.md): answered here, before the
// bun check, so a machine without bun still gets an answer saying so.
if (wantsHandshake(process.argv.slice(2))) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const phantom = spawnSync("phantom", ["--version"], { stdio: "ignore" }).status === 0;
  process.stdout.write(`${JSON.stringify(buildHandshake(version, { bun: hasBun(), phantom }))}\n`);
  process.exit(0);
}
if (!hasBun()) {
  process.stderr.write(
    "ashlr-plugin needs Bun 1.3 or newer, and bun was not found on PATH or in ~/.bun/bin.\n" +
      "Install it: curl -fsSL https://bun.sh/install | bash   (Windows: irm bun.sh/install.ps1 | iex)\n" +
      "Then open a new terminal and run ashlr-plugin again.\n",
  );
  process.exit(1);
}

const bun = resolveBunExecutable();
if (!bun) {
  process.stderr.write(
    "ashlr-plugin found bun earlier but could not resolve it now — open a new terminal and retry.\n",
  );
  process.exit(1);
}

const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
const child = spawn(bun, ["run", "--", cli, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });

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
  if (signal) {
    // Our own SIGINT/SIGTERM listeners above replace node's default action,
    // so re-raising with them attached would just exit 0. Drop them first so
    // the signal terminates this process the way it terminated the child.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 0);
});
