#!/usr/bin/env bun
/**
 * ashlr-websearch MCP server — standalone entry point.
 *
 * Imports websearch-server-handlers (registers ashlr__websearch into the
 * shared registry) then runs as a standalone stdio MCP server.
 *
 * For in-process router use, import websearch-server-handlers directly.
 */

import "./websearch-server-handlers";
import { runStandalone } from "./_tool-base";

// Re-export core logic so tests that import from this module keep working.
export { ashlrWebsearch, processWebSearchResults } from "./websearch-server-handlers";

if (import.meta.main) {
  await runStandalone("ashlr-websearch", "0.1.0");
}
