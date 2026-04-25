/**
 * read-server-handlers — registers ashlr__read into the shared tool registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrRead } from "./read-server";

registerTool({
  name: "ashlr__read",
  description:
    "Read a file with automatic snipCompact truncation for results > 2KB. " +
    "Preserves head + tail, elides middle. Lower-token alternative to the " +
    "built-in Read tool.",
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
