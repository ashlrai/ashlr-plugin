#!/usr/bin/env bun
/**
 * ashlr-diff MCP server — standalone entry point.
 *
 * Imports diff-server-handlers (registers ashlr__diff into the shared
 * registry) then runs as a standalone stdio MCP server. Existing plugin.json
 * entries continue to work unchanged through the v1.12 migration window.
 *
 * For in-process router use, import diff-server-handlers directly.
 */

import "./diff-server-handlers";
import { runStandalone } from "./_tool-base";

// Re-export core logic so existing tests that import from this module keep working.
export { ashlrDiff } from "./diff-server-handlers";

if (import.meta.main) {
  await runStandalone("ashlr-diff", "0.1.0");
}
