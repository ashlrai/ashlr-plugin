/**
 * ask-server-handlers — registers ashlr__ask on the shared registry.
 *
 * Routing decisions are delegated to _ask-router.ts (pure, no tool imports).
 * Dispatch today still calls the underlying tool functions directly; once
 * every downstream server (efficiency, orient, tree, glob) lives on the
 * registry, the dispatch can switch to `getTool(...).handler(...)` and drop
 * those imports entirely. Until then, this module imports ask-server's
 * existing `askHandler` which does the direct calls.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { askHandler } from "./ask-server";

registerTool({
  name: "ashlr__ask",
  description:
    "Single-tool entry point for ashlr. Accepts a natural-language question and " +
    "auto-routes to the correct underlying tool (ashlr__read, ashlr__grep, " +
    "ashlr__orient, ashlr__tree, or ashlr__glob) using deterministic rules — no " +
    "LLM in the routing step. Output always starts with a one-line trace showing " +
    "which tool fired and why.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "Natural-language question about the codebase",
      },
      cwd: {
        type: "string",
        description: "Working directory context (default: process.cwd())",
      },
    },
    required: ["question"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const a = (args ?? {}) as { question?: string; cwd?: string };
    try {
      const text = await askHandler({
        question: typeof a.question === "string" ? a.question : "",
        cwd: typeof a.cwd === "string" ? a.cwd : undefined,
      });
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `ashlr__ask error: ${message}` }], isError: true };
    }
  },
});
