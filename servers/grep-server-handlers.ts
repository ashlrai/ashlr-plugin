/**
 * grep-server-handlers — registers ashlr__grep into the shared tool registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrGrep } from "./grep-server";

registerTool({
  name: "ashlr__grep",
  description:
    "Search for a pattern. Use instead of native Grep always — genome-aware " +
    "when .ashlrcode/genome/ exists (returns only the most relevant pre-summarized " +
    "sections), falls back to ripgrep with LLM summarization for large result sets. " +
    "Compresses by filtering to relevant chunks; typical savings 70–90%.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Query or regex" },
      cwd: { type: "string", description: "Working directory (default: process.cwd())" },
      bypassSummary: {
        type: "boolean",
        description: "Skip LLM summarization, return rg output as-is (default: false)",
      },
    },
    required: ["pattern"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await ashlrGrep({
      pattern: String(args.pattern ?? ""),
      cwd: typeof args.cwd === "string" ? args.cwd : undefined,
      bypassSummary: args.bypassSummary === true,
    });
    return { content: [{ type: "text", text }] };
  },
});
