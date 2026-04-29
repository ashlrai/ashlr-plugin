#!/usr/bin/env bun
/**
 * ashlr-task MCP server — standalone entry point.
 *
 * Imports task-server-handlers (registers ashlr__task_list + ashlr__task_get
 * into the shared registry) then runs as a standalone stdio MCP server.
 *
 * For in-process router use, import task-server-handlers directly.
 */

import "./task-server-handlers";
import { runStandalone } from "./_tool-base";

// Re-export core logic so tests that import from this module keep working.
export {
  ashlrTaskList,
  ashlrTaskGet,
  processTaskListResults,
  processTaskGetResult,
} from "./task-server-handlers";

if (import.meta.main) {
  await runStandalone("ashlr-task", "0.1.0");
}
