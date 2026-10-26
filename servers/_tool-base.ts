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

import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ContextDb } from "./_embedding-cache";
import { detectMcpHost, type McpHost } from "./_mcp-host";
import { isPathRefusal } from "./_cwd-clamp";

const require = createRequire(import.meta.url);

/**
 * Crash logging, telemetry, and the embedding cache are only needed once a
 * tool runs. Importing them here would pull stats, sqlite, and the embedder
 * into initialize. The cache opener stays synchronous for existing callers.
 * The router always runs under Bun, and Bun can require this .ts file.
 * Node's require cannot. Do not import _tool-base from Node.
 * The async pieces use dynamic import.
 */
type CallDeps = {
  logEvent: typeof import("./_events").logEvent;
  writeCrashDump: typeof import("./_crash-dump").writeCrashDump;
  recordTelemetryEvent: typeof import("./_telemetry").recordTelemetryEvent;
  isTelemetryEnabled: typeof import("./_telemetry").isTelemetryEnabled;
};

let callDepsPromise: Promise<CallDeps> | null = null;

const NO_CALL_DEPS: CallDeps = {
  logEvent: async () => {},
  writeCrashDump: async () => {},
  recordTelemetryEvent: () => {},
  isTelemetryEnabled: () => false,
};

function loadCallDeps(): Promise<CallDeps> {
  if (!callDepsPromise) {
    callDepsPromise = (async () => {
      try {
        const [events, crash, telemetry] = await Promise.all([
          import("./_events"),
          import("./_crash-dump"),
          import("./_telemetry"),
        ]);
        return {
          logEvent: events.logEvent,
          writeCrashDump: crash.writeCrashDump,
          recordTelemetryEvent: telemetry.recordTelemetryEvent,
          isTelemetryEnabled: telemetry.isTelemetryEnabled,
        };
      } catch (err) {
        callDepsPromise = null;
        throw err;
      }
    })();
  }
  return callDepsPromise;
}

let _openContextDb: ((home?: string) => ContextDb) | null = null;

function openContextDb(home?: string): ContextDb {
  if (!_openContextDb) {
    _openContextDb = (
      require("./_embedding-cache.ts") as typeof import("./_embedding-cache")
    ).openContextDb;
  }
  return _openContextDb(home);
}

/** Protocol-native guidance applies to every MCP host without host-specific hooks. */
export const MCP_EFFICIENCY_INSTRUCTIONS = [
  "Use Ashlr tools for scoped, token-efficient repository retrieval: orient/tree for structure, grep for relevant symbols, then read the required files or ranges.",
  "Compact or summarized results are navigation aids. Retrieve omitted source before editing or verifying behavior; never treat omitted content as absent.",
  "Preserve task requirements, AGENTS.md instructions, authorization boundaries, citations, exact error details and verification evidence. Expand retrieval when any of these are missing.",
  "Use diff-format edits and focused tests. Savings estimates apply only to the tool output actually shortened; model quality, task success and token savings require separate evidence.",
].join("\n");

export interface ToolCallContext {
  /** CLAUDE_SESSION_ID (or ASHLR_SESSION_ID override) when present. */
  sessionId?: string;
  /** Raw process env — handlers should prefer this over globals for testability. */
  env: NodeJS.ProcessEnv;
  /** Which MCP host invoked this tool. Defaults to "claude-code" for backwards compat. */
  host?: McpHost;
  /**
   * When true, the handler should skip savings accounting (recordSaving).
   * Set by ashlr__pipe on intermediate ctx calls so that only the pipe
   * itself records ONE aggregate saving — not each sub-call individually.
   * Handlers that call recordSaving unconditionally may ignore this field;
   * the savings-server and stats helpers check it in the pipe's call path.
   */
  _noAccounting?: boolean;
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
 * Test helper: return a snapshot of the current registry so a caller can
 * restore it after a scoped reset. Pair with `__restoreRegistryForTests`
 * to keep the crash-isolation suite from leaking a wiped registry into
 * tests that depend on the production handler set being present.
 */
export function __snapshotRegistryForTests(): ReadonlyMap<string, ToolHandler> {
  return new Map(registry);
}

/** Test helper: overwrite the current registry with a previously snapshotted map. */
export function __restoreRegistryForTests(snap: ReadonlyMap<string, ToolHandler>): void {
  registry.clear();
  for (const [k, v] of snap) registry.set(k, v);
}

// ---------------------------------------------------------------------------
// Shared process-wide resources
// ---------------------------------------------------------------------------
//
// Handlers registered on a single router process share the expensive
// resources (SQLite handles, LLM clients) via the getters below. Before
// router consolidation, every server opened its own context.db handle —
// fine standalone, wasteful once N handlers live in one process. These
// getters are lazy so importing `_tool-base` stays cheap for tests that
// don't touch embedding infra.

let _sharedCtxDb: ContextDb | null = null;

/**
 * Process-wide embedding cache handle. Migrated handlers should call this
 * instead of `openContextDb()` directly so the router keeps one SQLite
 * handle per process. Honors `ASHLR_CONTEXT_DB_DISABLE=1` (returns a
 * no-op stub) since the underlying factory already does.
 *
 * Concurrency note: this check-then-set is safe only while `openContextDb()`
 * is synchronous (which it is today — bun:sqlite opens on the main thread).
 * If the factory ever becomes async, two concurrent awaits will each observe
 * `null` and open two handles. At that point, replace the lazy init with a
 * `Promise<ContextDb>` memo so the first caller owns the open.
 */
export function getEmbeddingCache(): ContextDb {
  if (!_sharedCtxDb) _sharedCtxDb = openContextDb();
  return _sharedCtxDb;
}

/**
 * Build an `isError: true` ToolResult for a caught exception with a
 * tool-specific prefix. Handlers that want to surface expected errors as
 * first-class results (rather than letting the dispatch catch emit a
 * `tool_crashed` event) use this to keep the boilerplate in one place.
 */
export function toErrorResult(prefix: string, err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `${prefix}: ${message}` }],
    isError: true,
  };
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
    { capabilities: { tools: {} }, instructions: MCP_EFFICIENCY_INSTRUCTIONS },
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
      host: detectMcpHost(),
    };
    // Stats, telemetry, and crash dumps load on the first call, not at startup.
    // The load is inside the try. A failed import returns isError and uses
    // no-op logging when those modules themselves failed to load.
    let deps: CallDeps = NO_CALL_DEPS;
    try {
      deps = await loadCallDeps();
      // SDK's ServerResult is a union that includes a task-based variant; a
      // typed ToolResult does not widen to the union from a variable, so we
      // cast at the call site (same effective shape, glob-server-style).
      const dispatchStart = Date.now();
      const result = (await tool.handler(req.params.arguments ?? {}, ctx)) as unknown;
      const dispatchMs = Date.now() - dispatchStart;

      // 1.1 — Emit tool_name on every MCP tool dispatch (opt-in, privacy-safe).
      // tool.name is the MCP tool name (e.g. "ashlr__grep"). No args/paths logged.
      if (deps.isTelemetryEnabled()) {
        deps.recordTelemetryEvent({
          kind: "tool_call",
          tool: tool.name,
          tool_name: tool.name,
          rawBytes: 0,       // byte accounting happens inside each handler
          compactBytes: 0,
          fellBack: false,
          providerUsed: "local",
          durationMs: dispatchMs,
        });
      }

      // Path refusals come back from many handlers as plain text; flag them so
      // hosts and agents see a failed call, not a successful read of a message.
      const first = (result as { content?: Array<{ text?: unknown }> })?.content?.[0];
      if (first && isPathRefusal(first.text)) (result as { isError?: boolean }).isError = true;

      return result as { content: unknown[] };
    } catch (err) {
      // Per-handler crash isolation: one handler's throw must not take the
      // whole router down. Emit a tool_crashed event for observability, write
      // a redacted on-disk crash dump for post-mortem, then return a
      // structured error response.
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      await deps.logEvent("tool_crashed", {
        tool: tool.name,
        reason: msg,
        extra: stack ? { stack: stack.split("\n").slice(0, 5).join("\n") } : undefined,
      }).catch(() => undefined);
      await deps.writeCrashDump({
        tool: tool.name,
        args: req.params.arguments ?? {},
        error: err,
      });
      return {
        content: [{ type: "text" as const, text: `[ashlr:${tool.name}] handler crashed: ${msg}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
