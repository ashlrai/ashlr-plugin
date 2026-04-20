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

import { logEvent } from "./_events";
import { ashlrRead, ashlrGrep } from "./efficiency-server";
import { orient } from "./orient-server";
import { ashlrTree } from "./tree-server";
import { ashlrGlob } from "./glob-server";
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

  let result: string;
  switch (decision.tool) {
    case "ashlr__read": {
      const path = decision.extracted ?? question;
      result = await ashlrRead({ path });
      break;
    }
    case "ashlr__grep": {
      const pattern = decision.extracted ?? question;
      result = await ashlrGrep({ pattern, cwd });
      break;
    }
    case "ashlr__orient": {
      const out = await orient({ query: question, dir: cwd });
      result = out.text;
      break;
    }
    case "ashlr__tree": {
      result = await ashlrTree({ path: cwd });
      break;
    }
    case "ashlr__glob": {
      const pattern = decision.extracted ?? question;
      result = await ashlrGlob({ pattern, cwd });
      break;
    }
    default: {
      const out = await orient({ query: question, dir: cwd });
      result = out.text;
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
