/**
 * read-server-handlers — registers ashlr__read into the shared tool registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrRead } from "./read-server";

registerTool({
  name: "ashlr__read",
  description:
    "Read a file with snipCompact truncation (head + tail, elided middle). " +
    "Use instead of native Read when the file is >2KB — avoids returning the " +
    "full payload; compresses by preserving only the structurally significant " +
    "head and tail; typical savings 60–90% on large files. " +
    "Pass bypassSummary:true to get the full file when you need it.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or cwd-relative file path" },
      bypassSummary: {
        type: "boolean",
        description: "Skip LLM summarization, return snipCompact-truncated content (default: false)",
      },
    },
    required: ["path"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await ashlrRead({
      path: String(args.path ?? ""),
      bypassSummary: args.bypassSummary === true,
    });
    return { content: [{ type: "text", text }] };
  },
});
