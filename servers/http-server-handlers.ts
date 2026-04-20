/**
 * http-server-handlers — registers ashlr__http on the shared registry so the
 * router can dispatch it alongside the other migrated tools. Logic remains in
 * http-server.ts for the standalone entry point.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { doFetch, type HttpArgs } from "./http-server";

registerTool({
  name: "ashlr__http",
  description:
    "HTTP fetch with compressed output. Readable-extracts main content from " +
    "HTML, pretty-prints + array-elides JSON, bounded byte cap. Refuses " +
    "non-http/https schemes and private hosts by default.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      method: { type: "string", description: "HTTP method (default GET)" },
      headers: { type: "object", description: "Request headers" },
      body: { type: "string", description: "Request body for POST/PUT" },
      mode: {
        type: "string",
        description: "'readable' (HTML→main content) | 'raw' | 'json' | 'headers'",
      },
      maxBytes: { type: "number", description: "Response body cap before compression (default 2_000_000)" },
      timeoutMs: { type: "number", description: "Request timeout (default 15000)" },
    },
    required: ["url"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await doFetch(args as unknown as HttpArgs);
    return { content: [{ type: "text", text }] };
  },
});
