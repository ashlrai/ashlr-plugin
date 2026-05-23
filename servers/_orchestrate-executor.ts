/**
 * _orchestrate-executor.ts — per-node executor for the Q1'27 orchestration runner.
 *
 * Two executors live here:
 *   - executeNodeStub: the original Bun.spawn `console.log('STUB-NODE: …')`
 *     path, refactored out of scripts/orchestrate-run.ts. PRODUCTION DEFAULT.
 *   - executeNodeLlm: real Claude wiring via servers/_llm-providers/ (auto
 *     dispatcher prefers anthropic, then cloud, etc). FLAG-GATED behind
 *     ASHLR_ORCHESTRATE_REAL_LLM=1.
 *
 * Both return the same ExecuteNodeResult shape so the runner can swap them
 * with a single ternary. AbortSignal is propagated to the underlying fetch
 * (LLM path) or kill() (stub path) for cancellation.
 *
 * Cost safety (LLM path):
 *   - Per-node hard token cap = min(node.estimatedTokens * 1.5, 5000).
 *   - If the model response would exceed the cap, we truncate the output
 *     to (cap * 4) characters (rough chars-per-token ≈ 4) and append
 *     "[truncated at cap]". The model still BILLS for outTokens the
 *     provider reports, but downstream nodes never see runaway text.
 *
 * Test seams:
 *   - _setProviderFactoryForTests lets the test suite inject a fake
 *     LlmProvider implementation without touching the real network.
 *   - _setSpawnImplForTests lets stub-path tests inject a fake Bun.spawn.
 */

import { selectProvider, type LlmProvider } from "./_llm-providers/index.ts";
import type { TaskNode } from "./_task-graph.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExecuteNodeOptions {
  node: TaskNode;
  handoffPayload: string;
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExecuteNodeResult {
  ok: boolean;
  output: string;
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// DI seams
// ---------------------------------------------------------------------------

type SpawnFn = typeof Bun.spawn;
type ProviderFactory = () => Promise<LlmProvider>;

let _spawnImpl: SpawnFn | null = null;
let _providerFactory: ProviderFactory | null = null;

/** Test seam: override Bun.spawn used by executeNodeStub. */
export function _setSpawnImplForTests(fn: SpawnFn | null): void {
  _spawnImpl = fn;
}

/** Test seam: override the LlmProvider factory used by executeNodeLlm. */
export function _setProviderFactoryForTests(fn: ProviderFactory | null): void {
  _providerFactory = fn;
}

function spawnGuarded(...args: Parameters<SpawnFn>): ReturnType<SpawnFn> {
  return (_spawnImpl ?? Bun.spawn)(...args);
}

async function resolveProvider(): Promise<LlmProvider> {
  if (_providerFactory) return _providerFactory();
  return selectProvider();
}

// ---------------------------------------------------------------------------
// Prompt template (LLM path)
// ---------------------------------------------------------------------------

/**
 * Build the prompt for one node. Exported so tests can assert that goal,
 * scope, and handoff context all reach the model verbatim.
 *
 * IMPORTANT: this prompt is intentionally READ-ONLY — the MVP does not
 * write files or run commands. Future milestones (q1-27 wk 10+) will lift
 * this restriction by handing the prompt to a Claude Code subagent.
 */
export function buildNodePrompt(node: TaskNode, handoffPayload: string): string {
  const scope = (node.scope ?? []).join(", ");
  const handoff = handoffPayload && handoffPayload.length > 0 ? handoffPayload : "(none)";
  return (
    "You are an orchestration agent executing one node of a task graph.\n" +
    `Node goal: ${node.goal}\n` +
    `Scope (files you may reference): ${scope}\n` +
    `Handoff context from completed predecessors: ${handoff}\n` +
    "\n" +
    "Produce a concise summary (≤500 words) of what would be done, files to edit, " +
    "and any blockers. DO NOT take destructive actions in this MVP — orchestrate-mode is read-only."
  );
}

// ---------------------------------------------------------------------------
// Stub executor (original Bun.spawn `console.log('STUB-NODE: …')` path)
// ---------------------------------------------------------------------------

interface SpawnEnv extends Record<string, string> {
  NODE_ID: string;
  NODE_GOAL: string;
  NODE_SCOPE: string;
  HANDOFF_PAYLOAD: string;
}

function buildSpawnEnv(node: TaskNode, handoffPayload: string): SpawnEnv {
  return {
    NODE_ID: node.id,
    NODE_GOAL: node.goal,
    NODE_SCOPE: (node.scope ?? []).join(":"),
    HANDOFF_PAYLOAD: handoffPayload,
  };
}

export async function executeNodeStub(opts: ExecuteNodeOptions): Promise<ExecuteNodeResult> {
  const t0 = Date.now();
  const env = buildSpawnEnv(opts.node, opts.handoffPayload);
  try {
    const proc = spawnGuarded(
      [
        "bun",
        "--eval",
        "console.log('STUB-NODE: ' + (process.env.NODE_ID || 'unknown'));",
      ],
      {
        env: { ...process.env, ...env },
        cwd: opts.cwd,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* best-effort */ }
    }, opts.timeoutMs);

    // Propagate AbortSignal to subprocess kill().
    const onAbort = () => {
      try { proc.kill(); } catch { /* best-effort */ }
    };
    opts.signal?.addEventListener("abort", onAbort);

    let stdout = "";
    let stderr = "";
    try {
      const stdoutPromise = proc.stdout instanceof ReadableStream
        ? new Response(proc.stdout).text()
        : Promise.resolve("");
      const stderrPromise = proc.stderr instanceof ReadableStream
        ? new Response(proc.stderr).text()
        : Promise.resolve("");
      stdout = await stdoutPromise;
      stderr = await stderrPromise;
      await proc.exited;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    const durationMs = Date.now() - t0;

    if (opts.signal?.aborted) {
      return { ok: false, output: stdout, error: "aborted", durationMs };
    }
    if (timedOut) {
      return {
        ok: false,
        output: stdout,
        error: `timeout after ${opts.timeoutMs}ms`,
        durationMs,
      };
    }

    const exitCode = typeof proc.exitCode === "number" ? proc.exitCode : 0;
    if (exitCode !== 0) {
      return {
        ok: false,
        output: stdout,
        error: stderr.trim() || `exit ${exitCode}`,
        durationMs,
      };
    }

    return { ok: true, output: stdout, durationMs };
  } catch (err) {
    return {
      ok: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    };
  }
}

// ---------------------------------------------------------------------------
// LLM executor (flag-gated, READ-ONLY)
// ---------------------------------------------------------------------------

const HARD_TOKEN_CAP = 5_000;
const TOKEN_CAP_MULTIPLIER = 1.5;
const CHARS_PER_TOKEN = 4; // rough — used only to bound output bytes

function computeTokenCap(node: TaskNode): number {
  const est = node.estimatedTokens ?? 0;
  return Math.min(Math.max(1, Math.floor(est * TOKEN_CAP_MULTIPLIER)), HARD_TOKEN_CAP);
}

function applyOutputCap(output: string, tokenCap: number): string {
  const charCap = tokenCap * CHARS_PER_TOKEN;
  if (output.length <= charCap) return output;
  return output.slice(0, charCap) + "\n[truncated at cap]";
}

/**
 * Execute one node via the configured LlmProvider.
 *
 * Pre-flight credential check: if the auto-selected provider is `none`
 * (no Anthropic key / no Pro token / no local LLM), we return
 * { ok: false, error: "no LLM credentials configured" } WITHOUT making any
 * network call. This guards the cost-safety story end-to-end.
 *
 * TODO(q1-27 wk 7-9): Team tier should draw from central quota; for now
 * Team uses user's own credentials (same path as Pro). When central quota
 * lands, this function should accept a tier hint and bill against the
 * team's shared bucket instead of the user's ANTHROPIC_API_KEY.
 */
export async function executeNodeLlm(opts: ExecuteNodeOptions): Promise<ExecuteNodeResult> {
  const t0 = Date.now();
  const tokenCap = computeTokenCap(opts.node);

  // Fast-fail when already aborted.
  if (opts.signal?.aborted) {
    return { ok: false, output: "", error: "aborted", durationMs: Date.now() - t0 };
  }

  // Resolve provider; bail with explicit error when no credentials exist.
  let provider: LlmProvider;
  try {
    provider = await resolveProvider();
  } catch (err) {
    return {
      ok: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    };
  }

  if (provider.name === "none") {
    return {
      ok: false,
      output: "",
      error: "no LLM credentials configured",
      durationMs: Date.now() - t0,
    };
  }

  // Build prompt (system) + node task description (user content).
  const prompt = buildNodePrompt(opts.node, opts.handoffPayload);

  // The LlmProvider.summarize signature takes (text, systemPrompt). We pass
  // an empty user text and put the full prompt in the system slot because
  // the Anthropic provider sets `system: prompt` + `messages: [{role:user,
  // content: text}]`. To keep the prompt visible as the user turn (better
  // model behavior for one-shot tasks), we instead put the prompt as user
  // content and use a minimal system prompt that tells the model to follow
  // it verbatim.
  const SYSTEM = "Follow the orchestration task in the user message exactly. Be concise.";

  // Race the provider call against AbortSignal so cancellations don't have
  // to wait for the full 15s provider timeout. The provider itself doesn't
  // accept an AbortSignal in its public surface today; this race gives us
  // the same effective behavior at the call-site.
  let response: { output: string; inTokens: number; outTokens: number };
  try {
    const summarizePromise = provider.summarize(prompt, SYSTEM, { maxTokens: tokenCap });
    if (opts.signal) {
      const abortPromise = new Promise<never>((_, reject) => {
        opts.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      response = await Promise.race([summarizePromise, abortPromise]);
    } else {
      response = await summarizePromise;
    }
  } catch (err) {
    return {
      ok: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    };
  }

  const capped = applyOutputCap(response.output, tokenCap);
  return {
    ok: true,
    output: capped,
    tokensIn: response.inTokens,
    tokensOut: response.outTokens,
    durationMs: Date.now() - t0,
  };
}
