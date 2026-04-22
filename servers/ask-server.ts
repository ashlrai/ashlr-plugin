#!/usr/bin/env bun
/**
 * ashlr-ask MCP server.
 *
 * Exposes a single tool (ashlr__ask) that accepts a natural-language question
 * and routes it to the correct underlying ashlr tool via deterministic rules —
 * no LLM involved in routing.
 *
 * Routing table (first match wins):
 *  1. glob token (e.g. **\/*.ts)          → ashlr__glob
 *  2. read/show-me/file + path token      → ashlr__read
 *  3. grep/find/search/where-is/which     → ashlr__grep
 *  4. structural (how does/explain/why)   → ashlr__orient
 *  5. list/tree/structure/directory       → ashlr__tree
 *  fallback                               → ashlr__orient
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Register the four tools askHandler dispatches to. Import only the specific
// handler modules — not _router-handlers — to avoid the circular dep chain:
// _router-handlers → ask-server-handlers → ask-server → _router-handlers.
import "./efficiency-server-handlers";
import "./orient-server-handlers";
import "./tree-server-handlers";
import "./glob-server-handlers";
import { logEvent } from "./_events";
import { getTool } from "./_tool-base";
import { extractKeywords } from "./_text-helpers";
import { routeQuestion, type RouteDecision, type RoutedTool } from "./_ask-router";

// Re-export for callers that historically imported these from ask-server.
export { routeQuestion, extractKeywords };
export type { RouteDecision, RoutedTool };

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function askHandler(input: { question: string; cwd?: string }): Promise<string> {
  const { question, cwd } = input;
  const decision = routeQuestion(question);

  // Log the routing decision for /ashlr-usage analytics.
  await logEvent("tool_call", {
    tool: "ashlr__ask",
    reason: `routed-to=${decision.tool}`,
    extra: { routeReason: decision.reason, extracted: decision.extracted ?? null },
  });

  const trace = `[ashlr__ask] routed to ${decision.tool} (${decision.reason})`;

  const ctx = {
    sessionId: process.env.CLAUDE_SESSION_ID || process.env.ASHLR_SESSION_ID || undefined,
    env: process.env,
  };

  let result: string;
  switch (decision.tool) {
    case "ashlr__read": {
      const toolH = getTool("ashlr__read");
      if (!toolH) throw new Error("ashlr__read not registered");
      const r = await toolH.handler({ path: decision.extracted ?? question }, ctx);
      result = r.content.map((c) => c.text).join("\n");
      break;
    }
    case "ashlr__grep": {
      const toolH = getTool("ashlr__grep");
      if (!toolH) throw new Error("ashlr__grep not registered");
      const r = await toolH.handler({ pattern: decision.extracted ?? question, cwd }, ctx);
      result = r.content.map((c) => c.text).join("\n");
      break;
    }
    case "ashlr__orient": {
      const toolH = getTool("ashlr__orient");
      if (!toolH) throw new Error("ashlr__orient not registered");
      const r = await toolH.handler({ query: question, dir: cwd }, ctx);
      result = r.content.map((c) => c.text).join("\n");
      break;
    }
    case "ashlr__tree": {
      const toolH = getTool("ashlr__tree");
      if (!toolH) throw new Error("ashlr__tree not registered");
      const r = await toolH.handler({ path: cwd }, ctx);
      result = r.content.map((c) => c.text).join("\n");
      break;
    }
    case "ashlr__glob": {
      const toolH = getTool("ashlr__glob");
      if (!toolH) throw new Error("ashlr__glob not registered");
      const r = await toolH.handler({ pattern: decision.extracted ?? question, cwd }, ctx);
      result = r.content.map((c) => c.text).join("\n");
      break;
    }
    default: {
      const toolH = getTool("ashlr__orient");
      if (!toolH) throw new Error("ashlr__orient not registered");
      const r = await toolH.handler({ query: question, dir: cwd }, ctx);
      result = r.content.map((c) => c.text).join("\n");
    }
  }

  return `${trace}\n${result}`;
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-ask", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
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
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name !== "ashlr__ask") {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    const a = (args ?? {}) as { question?: string; cwd?: string };
    const text = await askHandler({
      question: typeof a.question === "string" ? a.question : "",
      cwd: typeof a.cwd === "string" ? a.cwd : undefined,
    });
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `ashlr__ask error: ${message}` }], isError: true };
  }
});

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
