/**
 * multi-edit-server-handlers — registers ashlr__multi_edit on the shared registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrMultiEdit, type MultiEditArgs } from "./multi-edit-server";

registerTool({
  name: "ashlr__multi_edit",
  description:
    "Atomic refactors across files — apply N edits in ONE roundtrip instead of N. " +
    "Either ALL edits succeed or NONE are written (full rollback on any failure). " +
    "Reads each target file once and writes it once regardless of how many edits target it. " +
    "Use this instead of calling ashlr__edit N times for multi-file refactors; saves (N−1) × tool-call overhead and returns one consolidated diff summary.",
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
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
});
