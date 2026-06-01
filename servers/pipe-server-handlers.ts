/**
 * pipe-server-handlers — registers ashlr__pipe into the shared tool registry.
 *
 * ROLLOUT FLAG: the tool is only registered when ASHLR_PIPE_ENABLE=1.
 * When the flag is absent (the default), this module runs as a no-op so the
 * registered tool count stays at 40 and `bun run smoke:tools` keeps passing.
 *
 * To enable for testing:
 *   ASHLR_PIPE_ENABLE=1 bun test __tests__/pipe-server.test.ts
 *
 * The conditional registration is evaluated at import time (side-effect
 * module); the router imports this file unconditionally via _router-handlers.ts.
 */

import { registerTool, toErrorResult, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrPipe, type PipeArgs } from "./pipe-server";

// Guard: only register when the rollout flag is set.
if (process.env.ASHLR_PIPE_ENABLE === "1") {
  registerTool({
    name: "ashlr__pipe",
    description:
      "[EXPERIMENTAL] Executes model-authored JS code server-side — off by default, enable with ASHLR_PIPE_ENABLE=1. " +
      "Run a JS expression that calls ctx.{grep,read,ls,glob} internally — " +
      "intermediate results NEVER enter context, only the return value does. " +
      "Typical 80–95% token savings vs calling tools individually. " +
      "ctx methods accept the same args as the ashlr__ tools they wrap. " +
      "ctx.bash requires the additional ASHLR_PIPE_ALLOW_BASH=1 flag. " +
      "Example: ctx.grep({pattern:'TODO',cwd:'.'}) returns the grep text as a string.",
    inputSchema: {
      type: "object",
      properties: {
        expr: {
          type: "string",
          description:
            "Async function body (≤2000 chars). Receives `ctx` with " +
            "grep/read/ls/glob methods (always available) and bash (requires ASHLR_PIPE_ALLOW_BASH=1). " +
            "Return value is serialized as JSON. " +
            "Blocked tokens: process, Bun, require, import(, globalThis, eval, fetch(, etc.",
        },
        cwd: {
          type: "string",
          description: "Working directory for cwd-relative tool calls (default: project root).",
        },
        timeout_ms: {
          type: "number",
          description: "Execution timeout in ms (default 10000, hard max 30000).",
        },
        max_output_bytes: {
          type: "number",
          description: "Truncate output to this many bytes (default 4096).",
        },
      },
      required: ["expr"],
    },
    handler: async (
      args: Record<string, unknown>,
      ctx: ToolCallContext,
    ): Promise<ToolResult> => {
      try {
        const result = await ashlrPipe(args as unknown as PipeArgs, ctx);
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        return toErrorResult("ashlr__pipe error", err);
      }
    },
  });
}
