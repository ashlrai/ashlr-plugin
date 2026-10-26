/**
 * Register every MCP tool from _tool-catalog.json without importing handlers.
 *
 * tools/list reads the catalog. The first tools/call for a tool dynamic-imports
 * its handler module, which registerTool()s the real implementation over this
 * placeholder, then the call is forwarded. Regenerate the catalog with
 * `bun run gen:tool-catalog`.
 */

import {
  getTool,
  registerTool,
  type ToolCallContext,
  type ToolResult,
} from "./_tool-base";
import catalog from "./_tool-catalog.json" with { type: "json" };

export interface LazyToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
  /** Specifier resolved from this file. */
  module: string;
  /** Registered only when process.env[enableEnv] === "1". */
  enableEnv?: string;
}

export const LAZY_TOOLS = catalog as LazyToolSpec[];

const loads = new Map<string, Promise<void>>();

function loadModule(specifier: string): Promise<void> {
  const existing = loads.get(specifier);
  if (existing) return existing;
  const pending = import(specifier).then(
    () => undefined,
    (err: unknown) => {
      loads.delete(specifier);
      throw err;
    },
  );
  loads.set(specifier, pending);
  return pending;
}

function toolEnabled(spec: LazyToolSpec): boolean {
  return !spec.enableEnv || process.env[spec.enableEnv] === "1";
}

/** Register catalog tools. Call once, before the stdio server accepts requests. */
export function registerLazyTools(): void {
  for (const spec of LAZY_TOOLS) {
    if (!toolEnabled(spec)) continue;
    const specifier = spec.module;
    const name = spec.name;
    const handler = async (
      args: Record<string, unknown>,
      ctx: ToolCallContext,
    ): Promise<ToolResult> => {
      await loadModule(specifier);
      const real = getTool(name);
      if (!real || real.handler === handler) {
        throw new Error(`ashlr: ${name} did not register a handler from ${specifier}`);
      }
      return real.handler(args, ctx);
    };
    registerTool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      handler,
    });
  }
}
