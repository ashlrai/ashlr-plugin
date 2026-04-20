/**
 * logs-server-handlers — registers ashlr__logs on the shared registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrLogs, type LogsArgs } from "./logs-server";

registerTool({
  name: "ashlr__logs",
  description:
    "Tail a log file efficiently. Reads the last N lines (default 200), " +
    "detects severity from bracketed tags, bare prefixes, JSON/logfmt level " +
    "fields, and Python tracebacks, filters by level and/or ISO timestamp, " +
    "and collapses runs of identical consecutive lines into '(42x) ...'. " +
    "Supports glob paths. Lines with no parseable timestamp are skipped " +
    "(never fatal) when 'since' is set.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Log file path (supports glob)" },
      lines: { type: "number", description: "Tail window (default 200)" },
      level: {
        type: "string",
        description: "Filter: 'all' (default) | 'error' | 'warn' | 'error+warn'",
      },
      since: { type: "string", description: "ISO timestamp — only lines after this" },
      dedupe: {
        type: "boolean",
        description: "Collapse repeated consecutive lines with count (default: true)",
      },
      bypassSummary: {
        type: "boolean",
        description: "If true, skip LLM summarization and return the full rendered log tail.",
      },
    },
    required: ["path"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await ashlrLogs(args as unknown as LogsArgs);
    return { content: [{ type: "text", text }] };
  },
});
