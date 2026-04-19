#!/usr/bin/env bun
/**
 * ashlr-router — single long-lived MCP server that dispatches every ashlr__*
 * tool call to a handler registered via `_tool-base.ts`.
 *
 * STATUS: stub. Track A (feat/router-consolidation) fleshes out:
 *   - import side-effects that register every tool's handler
 *   - cross-tool cache sharing (genome LRU, summarizer pool, HTTP client)
 *   - heartbeat + auto-respawn contract with PreToolUse hook
 *   - per-handler crash isolation so one bad tool doesn't take down the rest
 *   - `ASHLR_ROUTER_DISABLE=1` fallback that exits early so the per-server
 *     plugin.json entries still start up
 *
 * Today this file exists so the other three tracks can reference it without
 * merge conflicts on structure.
 */

import { runStandalone } from "./_tool-base";
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
  await runStandalone("ashlr-router", process.env.ASHLR_VERSION ?? "dev");
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[ashlr-router] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
