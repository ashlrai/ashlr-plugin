/**
 * write-server-handlers — registers ashlr__write into the shared tool registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrWrite, formatWriteResult, type WriteArgs } from "./write-server";

registerTool({
  name: "ashlr__write",
  description:
    "Write content to a file without echoing the full content back. " +
    "If the file already exists, delegates to ashlr__edit (full-file replace, compact diff response). " +
    "If the file is new, creates it and returns a compact acknowledgment (path, bytes, sha8). " +
    "Either way, the full file content is never returned — ~80% token savings vs native Write.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute or cwd-relative path to write (`path` is accepted too)" },
      content: { type: "string", description: "File content to write" },
    },
    required: ["filePath", "content"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    // ashlr__read and ashlr__edit take `path`, so callers often pass it here too.
    const filePath = args.filePath ?? args.path;
    if (typeof filePath !== "string" || filePath === "") {
      return { content: [{ type: "text", text: "ashlr__write: filePath must be a non-empty string" }], isError: true };
    }
    if (typeof args.content !== "string") {
      return { content: [{ type: "text", text: "ashlr__write: content must be a string" }], isError: true };
    }
    const result = await ashlrWrite({ filePath, content: args.content } satisfies WriteArgs);
    return { content: [{ type: "text", text: formatWriteResult(result) }] };
  },
});
