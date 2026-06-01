/**
 * pipe-server — core logic for ashlr__pipe.
 *
 * ashlr__pipe lets the model run a multi-step JavaScript expression that
 * calls grep/read/bash/ls/glob internally. Intermediate results NEVER enter
 * the model context — only the expression's return value does. This yields
 * 80–95% token savings vs calling the same tools individually.
 *
 * ROLLOUT: tool is only registered when ASHLR_PIPE_ENABLE=1 (off by default
 * for v1.34). See pipe-server-handlers.ts for the registration guard.
 *
 * _noAccounting mechanism: ashlr__pipe calls intermediate tools via getTool()
 * handler dispatch. Those handlers internally call recordSaving(). To prevent
 * double-counting, pipe runs each intermediate call inside
 * _withSuppressedAccounting() (AsyncLocalStorage-scoped) so the inner
 * recordSaving() no-ops. The pipe then records ONE aggregate saving at the end
 * (rawBytes = sum of intermediate result sizes, compactBytes = final output).
 * Scoping is async-local, so a pipe in flight never suppresses a concurrent
 * unrelated tool call.
 */

import { getTool, type ToolCallContext } from "./_tool-base";
import { recordSaving, _withSuppressedAccounting } from "./_stats";
import { clampToCwd } from "./_cwd-clamp";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EXPR_LENGTH = 2000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4096;
/** Per-intermediate-result heap guard: 64 KB */
const INTERMEDIATE_CAP_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Security deny-list
//
// Defense-in-depth: reject expressions containing any of these tokens BEFORE
// executing. This is not a sandbox — it's a best-effort guardrail to prevent
// the most obvious misuse patterns (process exfiltration, dynamic import,
// prototype pollution, timing attacks). The AsyncFunction constructor already
// prevents direct access to module scope and closures; the deny-list adds a
// second layer for runtime globals that ARE accessible via the global object.
// ---------------------------------------------------------------------------

const DENY_TOKENS = [
  "process",
  "Bun",
  "require",
  "import(",
  "globalThis",
  "__proto__",
  "constructor[",
  "eval",
  "Function(",
  "setTimeout",
  "setInterval",
  "fetch(",
];

export interface PipeArgs {
  expr: string;
  cwd?: string;
  timeout_ms?: number;
  max_output_bytes?: number;
}

export interface PipeResult {
  text: string;
  /** Accumulated byte length of all intermediate results (for accounting). */
  rawIntermediate: number;
}

// ---------------------------------------------------------------------------
// Deadline helper
// ---------------------------------------------------------------------------

function makeDeadline(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    // Using the raw global setTimeout here is intentional — this is the
    // internal timeout mechanism, NOT user-supplied code. The deny-list
    // blocks "setTimeout" only in user expressions (expr).
    (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(
      () => reject(new Error(`ashlr__pipe: timed out after ${ms}ms`)),
      ms,
    ),
  );
}

// ---------------------------------------------------------------------------
// Build ctx proxy
// ---------------------------------------------------------------------------

/**
 * Build the `ctx` object passed into the user's expression.
 *
 * Each method (grep/read/bash/ls/glob) delegates to the corresponding
 * registered tool handler. Around each call, _setSuppressAccounting(true)
 * prevents the inner handler from recording savings — the pipe records ONE
 * aggregate at the end.
 *
 * Returns: `{ proxy, getIntermediate }` where `getIntermediate()` returns
 * the running byte total of all intermediate results.
 */
function buildCtx(parentCtx: ToolCallContext): {
  proxy: Record<string, (args: unknown) => Promise<string>>;
  getIntermediate: () => number;
} {
  let intermediateBytes = 0;

  async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const handler = getTool(name);
    if (!handler) throw new Error(`ashlr__pipe: tool "${name}" is not registered`);

    // Suppress savings accounting for this intermediate call, scoped to this
    // call's async tree only (AsyncLocalStorage). Concurrent unrelated tool
    // calls are never affected. The pipe records ONE aggregate at the end.
    const result = await _withSuppressedAccounting(() => handler.handler(args, parentCtx));

    const text = result.content.map((c) => c.text).join("");

    // Cap each intermediate result to INTERMEDIATE_CAP_BYTES (heap guard).
    const capped =
      text.length > INTERMEDIATE_CAP_BYTES
        ? text.slice(0, INTERMEDIATE_CAP_BYTES) +
          "\n[ashlr__pipe: intermediate result capped at 64KB]"
        : text;

    intermediateBytes += Buffer.byteLength(capped, "utf8");
    return capped;
  }

  const proxy: Record<string, (args: unknown) => Promise<string>> = {
    grep: (args: unknown) => callTool("ashlr__grep", args as Record<string, unknown>),
    read: (args: unknown) => callTool("ashlr__read", args as Record<string, unknown>),
    bash: (args: unknown) => callTool("ashlr__bash", args as Record<string, unknown>),
    ls: (args: unknown) => callTool("ashlr__ls", args as Record<string, unknown>),
    glob: (args: unknown) => callTool("ashlr__glob", args as Record<string, unknown>),
  };

  return { proxy, getIntermediate: () => intermediateBytes };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function ashlrPipe(args: PipeArgs, ctx: ToolCallContext): Promise<PipeResult> {
  const { expr, cwd, timeout_ms, max_output_bytes } = args;

  // --- Input validation ---

  if (typeof expr !== "string" || expr.length === 0) {
    throw new Error("ashlr__pipe: expr must be a non-empty string");
  }

  if (expr.length > MAX_EXPR_LENGTH) {
    throw new Error(
      `ashlr__pipe: expr exceeds ${MAX_EXPR_LENGTH} characters (got ${expr.length})`,
    );
  }

  // Deny-list check — must happen BEFORE constructing/executing the function.
  for (const token of DENY_TOKENS) {
    if (expr.includes(token)) {
      throw new Error(
        `ashlr__pipe: expr contains disallowed token "${token}" — ` +
          `process/Bun/require/import/globalThis/eval/fetch and similar globals are blocked`,
      );
    }
  }

  // Timeout validation.
  const timeoutMs = (() => {
    if (timeout_ms === undefined) return DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeout_ms) || timeout_ms <= 0) {
      throw new Error(
        `ashlr__pipe: timeout_ms must be a positive finite number (got ${timeout_ms})`,
      );
    }
    return Math.min(timeout_ms, MAX_TIMEOUT_MS);
  })();

  const maxOutputBytes = (() => {
    if (max_output_bytes === undefined) return DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isFinite(max_output_bytes) || max_output_bytes <= 0) {
      throw new Error(
        `ashlr__pipe: max_output_bytes must be a positive finite number (got ${max_output_bytes})`,
      );
    }
    return max_output_bytes;
  })();

  // cwd clamp — optional; if provided must be inside an allowed root.
  if (cwd !== undefined) {
    const clamp = clampToCwd(cwd, "ashlr__pipe");
    if (!clamp.ok) {
      throw new Error(clamp.message);
    }
  }

  // --- Build the expression function ---
  //
  // Use AsyncFunction constructor, NOT eval. This creates a new function
  // scope that does NOT capture the module's closures or `require`. The only
  // binding available to the user expression is the explicit `ctx` argument.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (ctx: unknown) => Promise<unknown>;

  // Force strict mode on the user body. In sloppy mode a Function-constructed
  // function sees `this === globalThis` at call time, which would let an expr
  // reach real globals via `this["pro"+"cess"]` and defeat the substring
  // deny-list (token-splitting). Strict mode makes `this` undefined and turns
  // implicit-global access into a ReferenceError — the deny-list is then a
  // second layer, not the only one.
  const fn = new AsyncFunction("ctx", `"use strict";\n${expr}`);

  // --- Execute with deadline race ---

  const { proxy, getIntermediate } = buildCtx(ctx);

  let rawValue: unknown;
  try {
    rawValue = await Promise.race([fn(proxy), makeDeadline(timeoutMs)]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg);
  }

  // --- Serialize return value ---

  let serialized: string;
  try {
    serialized = JSON.stringify(rawValue, null, 2) ?? "null";
  } catch {
    // Circular references or non-serializable values (BigInt, etc.).
    serialized = "[non-serializable result]";
  }

  // --- Truncate to max_output_bytes ---

  const outputBytes = Buffer.byteLength(serialized, "utf8");
  let output = serialized;
  if (outputBytes > maxOutputBytes) {
    // Slice at byte boundary (Buffer) to avoid splitting a multi-byte codepoint.
    output =
      Buffer.from(serialized, "utf8").slice(0, maxOutputBytes).toString("utf8") +
      "\n[ashlr__pipe: output truncated]";
  }

  // --- Savings accounting ---
  //
  // ONE aggregate recording for the entire pipe execution:
  //   rawBytes    = sum of all intermediate result byte lengths
  //                 (what the model would have seen calling tools individually)
  //   compactBytes = final output byte length (what the model actually sees)
  //
  // Intermediate ctx calls had _setSuppressAccounting(true) active so they
  // called recordSaving but it returned 0 immediately — no double-counting.

  const rawBytes = getIntermediate();
  const compactBytes = Buffer.byteLength(output, "utf8");
  if (rawBytes > 0) {
    // Fire-and-forget; accounting errors must never surface to the caller.
    recordSaving(rawBytes, compactBytes, "ashlr__pipe", {
      sessionId: ctx.sessionId,
    }).catch(() => undefined);
  }

  return { text: output, rawIntermediate: rawBytes };
}
