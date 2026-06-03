#!/usr/bin/env bun
/**
 * ashlr-mcp — dedicated stdio MCP launcher.
 *
 * This is intentionally separate from `ashlr` so MCP hosts never invoke the
 * stats CLI by accident. It launches the consolidated router through the same
 * bootstrap path used by plugin manifests, preserving first-run dependency
 * installation and workspace allow-list behavior.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(__filename), "..");

process.env.ASHLR_MCP_HOST ||= "generic";

const entrypoint = join(PLUGIN_ROOT, "scripts", "mcp-entrypoint.ts");
const child = Bun.spawn(
  ["bun", "run", entrypoint, "servers/_router.ts", ...process.argv.slice(2)],
  {
    cwd: PLUGIN_ROOT,
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // Child may already be gone.
    }
  });
}

const exitCode = await child.exited;
process.exit(exitCode);
