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
import "./_router-handlers";

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

  const toolCount = listTools().length;
  process.stderr.write(
    `[ashlr-router] starting · ${toolCount} tools registered · version=${process.env.ASHLR_VERSION ?? "dev"}\n`,
  );

  await runStandalone("ashlr-router", process.env.ASHLR_VERSION ?? "dev");
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[ashlr-router] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
