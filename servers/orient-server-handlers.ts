/**
 * orient-server-handlers — side-effect module.
 *
 * Importing this file registers the ashlr__orient tool into the shared
 * registry (_tool-base.ts). Logic stays in orient-server.ts during the
 * v1.12 → v1.13 migration window; this module is a thin dispatch adapter
 * so the tool can be served by the in-process router alongside the rest.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { orient, type OrientArgs } from "./orient-server";

registerTool({
  name: "ashlr__orient",
  description:
    "Answer codebase questions in one read-only call: scan tree, find relevant files via genome or ripgrep, compact them and ask a local LLM for a short synthesis and suggested next tool.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Question about the codebase: 'how does auth work', 'where is X defined', 'what's the deploy flow'",
      },
      dir: {
        type: "string",
        description: "Project root (default: process.cwd())",
      },
      depth: {
        type: "string",
        enum: ["quick", "thorough"],
        description:
          "'quick' (1 tool call + 3 reads, ~2s) | 'thorough' (tree + grep + 6 reads, ~4s, default)",
      },
    },
    required: ["query"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    // Only the documented arguments are read. An extra `endpointOverride` (or
    // any other key) is ignored: the LLM endpoint comes from user config only.
    const a = args as Partial<OrientArgs>;
    const out = await orient({
      query: typeof a.query === "string" ? a.query : "",
      dir: typeof a.dir === "string" ? a.dir : undefined,
      depth: a.depth === "quick" || a.depth === "thorough" ? a.depth : undefined,
    });
    return { content: [{ type: "text", text: out.text }] };
  },
});
