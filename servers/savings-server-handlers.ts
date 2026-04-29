/**
 * savings-server-handlers — registers ashlr__savings into the shared tool registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrSavings } from "./savings-server";

registerTool({
  name: "ashlr__savings",
  description: "Show estimated tokens and cost saved by ashlr tools in the current session and lifetime totals. Use instead of manually counting tool calls to measure ashlr efficiency.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    return {
      content: [{ type: "text", text: await ashlrSavings() }],
    };
  },
});
