#!/usr/bin/env bun
/**
 * ashlr-ls MCP server — standalone entry point.
 *
 * Imports ls-server-handlers (registers ashlr__ls into the shared
 * registry) then runs as a standalone stdio MCP server. Existing plugin.json
 * entries continue to work unchanged through the v1.12 migration window.
 *
 * For in-process router use, import ls-server-handlers directly.
 */

import "./ls-server-handlers";
import { runStandalone } from "./_tool-base";

// Re-export core logic so existing tests that import from this module keep working.
export { handleLs } from "./ls-server-handlers";

if (import.meta.main) {
  await runStandalone("ashlr-ls", "0.1.0");
}
