#!/usr/bin/env bun
/**
 * ashlr-webfetch MCP server — standalone entry point.
 *
 * Imports webfetch-server-handlers (registers ashlr__webfetch into the shared
 * registry) then runs as a standalone stdio MCP server. Existing plugin.json
 * entries continue to work unchanged through the v1.12 migration window.
 *
 * For in-process router use, import webfetch-server-handlers directly.
 */

import "./webfetch-server-handlers";
import { runStandalone } from "./_tool-base";

// Re-export core logic so existing tests that import from this module keep working.
export { doWebFetch } from "./webfetch-server-handlers";

if (import.meta.main) {
  await runStandalone("ashlr-webfetch", "0.1.0");
}
