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
      startLine: { type: "number", description: "1-based first line of a range read (use with the L<start>-L<end> hints in an ast-skeleton)" },
      endLine: { type: "number", description: "1-based last line of a range read (default startLine+199)" },
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
      startLine: typeof args.startLine === "number" ? args.startLine : undefined,
      endLine: typeof args.endLine === "number" ? args.endLine : undefined,
      mode: ["auto", "ast", "snip"].includes(String(args.mode ?? ""))
        ? (args.mode as "auto" | "ast" | "snip")
        : undefined,
    });
    return { content: [{ type: "text", text }] };
  },
});
