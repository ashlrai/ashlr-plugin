#!/usr/bin/env bun
/**
 * ashlr-router — single long-lived MCP process hosting all 40 ashlr__* tools.
 *
 * One process replaces the old N-process architecture where each tool spawned
 * its own child. Shared resources (SQLite embedding cache, summarizer pool,
 * genome LRU) are initialized once and reused across every tool call.
 *
 * Architecture:
 *   - `_router-handlers.ts` imports every handler module as a side-effect,
 *     which registers all tools into the shared registry in `_tool-base.ts`.
 *   - `runStandalone()` boots a single MCP stdio server that dispatches
 *     `tools/list` and `tools/call` via the registry.
 *   - Per-handler crash isolation: one handler throwing does NOT kill the
 *     process — the dispatch boundary in `_tool-base.ts::runStandalone` wraps
 *     each call in try/catch and returns `isError: true` with a crash-dump.
 *   - `ASHLR_ROUTER_DISABLE=1` short-circuits and exits cleanly so legacy
 *     per-server plugin.json entries can take over if needed.
 *
 * Legacy entrypoints (efficiency-server.ts, grep-server.ts, …) keep their
 * `if (import.meta.main)` guards intact so they still work for direct
 * invocation and for smoke tests.
 */

import { listTools, runStandalone } from "./_tool-base";
import { detectMcpHost } from "./_mcp-host";
import { adoptLaunchCwd } from "./_cwd-clamp";
import "./_router-handlers";
import { readFileSync } from "fs";
import { join } from "path";

/** Reported in MCP `serverInfo` and the startup banner; ASHLR_VERSION overrides. */
function pluginVersion(): string {
  if (process.env.ASHLR_VERSION) return process.env.ASHLR_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    // A partial copy of the plugin without package.json: report "dev".
  }
  return "dev";
}

const VERSION = pluginVersion();

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env.ASHLR_ROUTER_DISABLE === "1") {
    process.stderr.write(
      "[ashlr-router] ASHLR_ROUTER_DISABLE=1 set; exiting so per-server entries run instead.\n",
    );
    process.exit(0);
  }

  adoptLaunchCwd();
  const toolCount = listTools().length;
  const host = detectMcpHost();
  process.stderr.write(
    `[ashlr-router] starting · ${toolCount} tools registered · version=${VERSION} · host=${host}\n`,
  );

  await runStandalone("ashlr-router", VERSION);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[ashlr-router] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
