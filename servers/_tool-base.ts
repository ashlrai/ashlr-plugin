/**
 * Shared MCP server scaffold.
 *
 * Tools migrate from per-server boilerplate (stdio setup, ListTools/CallTool
 * request handlers, lookup-by-name switch) to this handler-style registration
 * so they can be composed into a single router process (see `_router.ts`) or
 * continue running as standalone MCP servers via `runStandalone()`.
 *
 * Adoption is incremental. Existing servers keep working unchanged; they can
 * opt-in by switching their `new Server(...)` + `setRequestHandler(...)`
 * boilerplate to `registerTool({...})` + `runStandalone(name)`.
 *
 * Cross-track contract: all four tracks (router, context-db, ast, compression)
 * target this interface so handlers can be hoisted into `_router.ts` without
 * per-track refactors.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface ToolCallContext {
  /** CLAUDE_SESSION_ID (or ASHLR_SESSION_ID override) when present. */
  sessionId?: string;
  /** Raw process env — handlers should prefer this over globals for testability. */
  env: NodeJS.ProcessEnv;
}

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  isError?: boolean;
}

export interface ToolHandler {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolResult>;
}

const registry = new Map<string, ToolHandler>();

/**
 * Register a tool handler. Safe to call multiple times per-name (last
 * registration wins — useful for tests and for track overrides during the
 * router rollout).
 */
export function registerTool(tool: ToolHandler): void {
  registry.set(tool.name, tool);
}

/** Return all currently registered handlers. */
export function listTools(): ToolHandler[] {
  return Array.from(registry.values());
}

/** Lookup a registered handler by name. */
export function getTool(name: string): ToolHandler | undefined {
  return registry.get(name);
}

/** Test helper: drop all registrations. Do not call from production code. */
export function __resetRegistryForTests(): void {
  registry.clear();
}

/**
 * Run the current tool registry as a standalone MCP server on stdio. Used by
 * per-server entry points during the v1.12 → v1.13 migration so stale
 * `plugin.json` files keep working. After router migration completes, most
 * callers will go through `_router.ts` instead.
 */
export async function runStandalone(
  serverName: string,
  serverVersion: string = "1.0.0",
): Promise<void> {
  const server = new Server(
    { name: serverName, version: serverVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Matches the inline pattern every per-server uses today: TS infers the
  // object-literal return as a valid variant of the SDK's ServerResult union.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = getTool(req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    const ctx: ToolCallContext = {
      sessionId:
        process.env.CLAUDE_SESSION_ID || process.env.ASHLR_SESSION_ID || undefined,
      env: process.env,
    };
    try {
      // SDK's ServerResult is a union that includes a task-based variant; a
      // typed ToolResult does not widen to the union from a variable, so we
      // cast at the call site (same effective shape, glob-server-style).
      const result = (await tool.handler(req.params.arguments ?? {}, ctx)) as unknown;
      return result as { content: unknown[] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `[ashlr:${tool.name}] handler error: ${msg}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
