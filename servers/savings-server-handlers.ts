/**
 * savings-server-handlers — registers ashlr__savings into the shared tool registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrSavings } from "./savings-server";

registerTool({
  name: "ashlr__savings",
  description: "Return estimated tokens saved in the current session and lifetime totals.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    return {
      content: [{ type: "text", text: await ashlrSavings() }],
    };
  },
});
