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
      filePath: { type: "string", description: "Absolute or cwd-relative path to write" },
      content: { type: "string", description: "File content to write" },
    },
    required: ["filePath", "content"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const result = await ashlrWrite(args as unknown as WriteArgs);
    return { content: [{ type: "text", text: formatWriteResult(result) }] };
  },
});
