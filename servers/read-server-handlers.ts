/**
 * read-server-handlers — registers ashlr__read into the shared tool registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrRead } from "./read-server";

registerTool({
  name: "ashlr__read",
  description:
    "Read files instead of native Read with compact head/tail or AST summaries. Pass bypassSummary:true to skip LLM summarization; snipCompact truncation still applies.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or cwd-relative file path" },
      bypassSummary: {
        type: "boolean",
        description: "Skip LLM summarization, return snipCompact-truncated content (default: false)",
      },
      mode: {
        type: "string",
        enum: ["auto", "ast", "snip"],
        description: "auto (default): use AST skeleton for large wired-lang files; ast: force skeleton; snip: force snipCompact head+tail",
      },
    },
    required: ["path"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await ashlrRead({
      path: String(args.path ?? ""),
      bypassSummary: args.bypassSummary === true,
      mode: ["auto", "ast", "snip"].includes(String(args.mode ?? ""))
        ? (args.mode as "auto" | "ast" | "snip")
        : undefined,
    });
    return { content: [{ type: "text", text }] };
  },
});
