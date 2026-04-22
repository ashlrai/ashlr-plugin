#!/usr/bin/env bun
/**
 * ashlr-test MCP server — standalone entry point.
 *
 * Imports test-server-handlers (registers ashlr__test into the shared
 * registry) then runs as a standalone stdio MCP server. Existing plugin.json
 * entries continue to work unchanged through the migration window.
 *
 * For in-process router use, import test-server-handlers directly.
 */

import "./test-server-handlers";
import { runStandalone } from "./_tool-base";

// Re-export core logic so tests that import from this module keep working.
export { ashlrTest } from "./test-server-handlers";

if (import.meta.main) {
  await runStandalone("ashlr-test", "0.1.0");
}
