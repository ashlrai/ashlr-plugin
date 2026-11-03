/**
 * edit-server-handlers — registers ashlr__edit into the shared tool registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrEdit, type EditArgs } from "./edit-server";

registerTool({
  name: "ashlr__edit",
  description:
    "One literal replacement with compact diff instead of native Edit. Strict mode requires one match. Use ashlr__multi_edit for batch edits or ashlr__edit_structural for symbol renames.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or cwd-relative file path" },
      search: { type: "string", description: "Exact text to find" },
      replace: { type: "string", description: "Replacement text" },
      strict: { type: "boolean", description: "Require exactly one match (default: true)" },
    },
    required: ["path", "search", "replace"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const res = await ashlrEdit(args as unknown as EditArgs);
    return { content: [{ type: "text", text: res.text }] };
  },
});
