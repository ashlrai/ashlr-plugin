/**
 * edit-server-handlers — registers ashlr__edit into the shared tool registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrEdit, type EditArgs } from "./edit-server";

registerTool({
  name: "ashlr__edit",
  description:
    "Single literal search/replace in one file, returns only a diff summary. " +
    "Use instead of native Edit when the file is >5KB or the combined before/after " +
    "is >=80 chars — avoids the full file round-trip. Compresses by returning only " +
    "the changed lines; typical savings 80%. In strict mode (default) requires " +
    "exactly one match. For many edits across files use ashlr__multi_edit instead. " +
    "For symbol renames use ashlr__edit_structural instead.",
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
