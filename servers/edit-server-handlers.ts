/**
 * edit-server-handlers — registers ashlr__edit into the shared tool registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrEdit, type EditArgs } from "./edit-server";

registerTool({
  name: "ashlr__edit",
  description:
    "Apply a search/replace edit in-place and return only a diff summary. In " +
    "strict mode (default), requires exactly one match for safety. Set " +
    "strict:false to replace all occurrences.",
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
