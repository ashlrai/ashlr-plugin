#!/usr/bin/env node
/**
 * ashlr-plugin package bin — node launcher for scripts/cli.ts.
 *
 * npm installs this as `ashlr-plugin`. The CLI itself runs under bun; this
 * shim finds bun (PATH, then ~/.bun/bin) and otherwise explains how to get it,
 * instead of failing with `/usr/bin/env: 'bun': No such file or directory`.
 * It never installs anything.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasBun, prependBunToPath } from "./bun-resolve.mjs";

if (!hasBun()) prependBunToPath();
if (!hasBun()) {
  process.stderr.write(
    "ashlr-plugin needs Bun 1.3 or newer, and bun was not found on PATH or in ~/.bun/bin.\n" +
      "Install it: curl -fsSL https://bun.sh/install | bash   (Windows: irm bun.sh/install.ps1 | iex)\n" +
      "Then open a new terminal and run ashlr-plugin again.\n",
  );
  process.exit(1);
}

const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
const child = spawn("bun", ["run", cli, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });

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
