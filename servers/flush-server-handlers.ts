/**
 * flush-server-handlers — registers ashlr__flush into the shared tool registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { flushPending } from "./flush-server";

registerTool({
  name: "ashlr__flush",
  description:
    "Flush all queued ashlr__edit writes to disk immediately and return a " +
    "summary of what was committed. Use when you need to read a file you just " +
    "edited, or at the end of a multi-edit sequence.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const summary = await flushPending();
    return {
      content: [{ type: "text", text: summary || "[ashlr__flush] nothing to flush" }],
    };
  },
});
