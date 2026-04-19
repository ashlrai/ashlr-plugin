#!/usr/bin/env bun
/**
 * ashlr-tree MCP server — standalone entry point.
 *
 * Imports tree-server-handlers (registers ashlr__tree into the shared
 * registry) then runs as a standalone stdio MCP server. Existing plugin.json
 * entries continue to work unchanged through the v1.12 migration window.
 *
 * For in-process router use, import tree-server-handlers directly.
 */

import "./tree-server-handlers";
import { runStandalone } from "./_tool-base";

// Re-export core logic so existing tests that import from this module keep working.
export { ashlrTree } from "./tree-server-handlers";

if (import.meta.main) {
  await runStandalone("ashlr-tree", "0.1.0");
}
