/**
 * multi-edit-server-handlers — registers ashlr__multi_edit on the shared registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrMultiEdit, type MultiEditArgs } from "./multi-edit-server";

registerTool({
  name: "ashlr__multi_edit",
  description:
    "Apply edits across files atomically instead of separate Edit calls; rolls back on failure and returns one diff summary. Use ashlr__edit for one file or ashlr__edit_structural for symbol renames.",
  inputSchema: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        description: "Ordered list of edits to apply atomically.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or cwd-relative file path. File must exist." },
            search: { type: "string", description: "Exact string to find in the file." },
            replace: { type: "string", description: "String to replace it with." },
            strict: {
              type: "boolean",
              description: "Default true: require exactly one match (error if 0 or 2+). Pass false to replace all occurrences.",
            },
          },
          required: ["path", "search", "replace"],
        },
      },
    },
    required: ["edits"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const text = await ashlrMultiEdit((args ?? {}) as unknown as MultiEditArgs);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // multi-edit returns the raw message (no prefix) so callers see the
      // underlying tool's diagnostic verbatim — distinct from the tool-prefixed
      // shape of other handlers.
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
});
