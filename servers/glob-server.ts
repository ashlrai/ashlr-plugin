#!/usr/bin/env bun
/**
 * ashlr-glob MCP server — standalone entry point.
 *
 * Imports glob-server-handlers (registers ashlr__glob into the shared
 * registry) then runs as a standalone stdio MCP server. Existing plugin.json
 * entries continue to work unchanged through the v1.12 migration window.
 *
 * For in-process router use, import glob-server-handlers directly.
 */

import "./glob-server-handlers";
import { runStandalone } from "./_tool-base";

// Re-export core logic so existing tests that import from this module keep working.
export { ashlrGlob } from "./glob-server-handlers";

if (import.meta.main) {
  await runStandalone("ashlr-glob", "0.1.0");
}
