/**
 * orchestrate-executor.test.ts — coverage for executeNodeStub + executeNodeLlm.
 *
 * Both executors are exercised via DI seams — no real subprocess, no real
 * network. We assert:
 *
 *   stub path:
 *     - returns ok=true with stdout captured
 *     - propagates AbortSignal to subprocess.kill()
 *
 *   LLM path:
 *     - prompt template includes goal, scope, and handoff payload
 *     - response text becomes `output`; tokensIn/Out populated
 *     - cap enforcement: oversized response truncated + suffix
 *     - provider failure surfaces as ok:false (no throw)
 *     - AbortSignal aborts quickly
 *     - no credentials (provider name === "none") returns explicit error
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildNodePrompt,
  executeNodeLlm,
  executeNodeStub,
  _setProviderFactoryForTests,
  _setSpawnImplForTests,
} from "../servers/_orchestrate-executor";
import type { LlmProvider } from "../servers/_llm-providers/index";
import type { TaskNode } from "../servers/_task-graph";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: "node-a",
    agentKind: "refactorer",
    goal: "refactor the auth module",
    scope: ["src/auth.ts", "src/session.ts"],
    deps: [],
    estimatedTokens: 1000,
    ...overrides,
  };
}

function makeFakeProvider(impl: Partial<LlmProvider> & {
  name?: LlmProvider["name"];
  summarize?: LlmProvider["summarize"];
}): LlmProvider {
  return {
    name: impl.name ?? "anthropic",
    async isAvailable() { return true; },
    summarize: impl.summarize ?? (async () => ({
      output: "ok", inTokens: 1, outTokens: 1, latencyMs: 0,
    })),
  };
}

function mockSpawn(
  handler: () => {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    delayMs?: number;
  },
) {
  const calls: Array<{ cmd: string[]; env: Record<string, string> }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = ((cmd: string[], opts?: any) => {
    const env = (opts?.env ?? {}) as Record<string, string>;
    calls.push({ cmd, env });
    const res = handler();
    const stdoutStr = res.stdout ?? "";
    const stderrStr = res.stderr ?? "";
    const exitCode = res.exitCode ?? 0;
    const delayMs = res.delayMs ?? 0;

    let killed = false;
    const proc: Record<string, unknown> = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          if (stdoutStr) controller.enqueue(new TextEncoder().encode(stdoutStr));
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          if (stderrStr) controller.enqueue(new TextEncoder().encode(stderrStr));
          controller.close();
        },
      }),
      exitCode,
      kill: () => { killed = true; },
      exited: new Promise<number>((resolve) => {
        if (delayMs > 0) {
          const timer = setTimeout(() => resolve(exitCode), delayMs);
          const interval = setInterval(() => {
            if (killed) {
              clearTimeout(timer);
              clearInterval(interval);
              resolve(137);
            }
          }, 5);
        } else {
          resolve(exitCode);
        }
      }),
    };
    return proc as unknown as ReturnType<typeof Bun.spawn>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _setProviderFactoryForTests(null);
  _setSpawnImplForTests(null);
});

afterEach(() => {
  _setProviderFactoryForTests(null);
  _setSpawnImplForTests(null);
});

// ---------------------------------------------------------------------------
// buildNodePrompt
// ---------------------------------------------------------------------------

describe("buildNodePrompt", () => {
  test("includes node goal, scope, and handoff payload verbatim", () => {
    const node = makeNode({ goal: "rename foo to bar", scope: ["a.ts", "b.ts"] });
    const prompt = buildNodePrompt(node, "context from upstream");
    expect(prompt).toContain("Node goal: rename foo to bar");
    expect(prompt).toContain("Scope (files you may reference): a.ts, b.ts");
    expect(prompt).toContain("Handoff context from completed predecessors: context from upstream");
    expect(prompt).toContain("DO NOT take destructive actions");
  });

  test("substitutes '(none)' when handoff payload is empty", () => {
    const prompt = buildNodePrompt(makeNode(), "");
    expect(prompt).toContain("Handoff context from completed predecessors: (none)");
  });
});

// ---------------------------------------------------------------------------
// executeNodeStub
// ---------------------------------------------------------------------------

describe("executeNodeStub", () => {
  test("captures subprocess stdout as output, ok=true on exit 0", async () => {
    const { fn } = mockSpawn(() => ({ stdout: "STUB-NODE: node-a\n", exitCode: 0 }));
    _setSpawnImplForTests(fn);
    const res = await executeNodeStub({
      node: makeNode(),
      handoffPayload: "",
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("STUB-NODE: node-a");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("non-zero exit surfaces stderr as error", async () => {
    const { fn } = mockSpawn(() => ({ stderr: "boom", exitCode: 1 }));
    _setSpawnImplForTests(fn);
    const res = await executeNodeStub({
      node: makeNode(),
      handoffPayload: "",
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom");
  });

  test("propagates AbortSignal to subprocess.kill()", async () => {
    const ctl = new AbortController();
    const { fn } = mockSpawn(() => ({ stdout: "", exitCode: 0, delayMs: 1000 }));
    _setSpawnImplForTests(fn);
    // Fire abort on next tick so the executor gets to attach its listener.
    setTimeout(() => ctl.abort(), 10);
    const res = await executeNodeStub({
      node: makeNode(),
      handoffPayload: "",
      timeoutMs: 5000,
      signal: ctl.signal,
    });
    expect(res.ok).toBe(false);
    // After abort the proc.exited resolves to 137 (SIGKILL) — either path
    // is acceptable; the key invariant is ok=false and quick return.
    expect(res.durationMs).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// executeNodeLlm
// ---------------------------------------------------------------------------

describe("executeNodeLlm", () => {
  test("sends prompt to provider with goal/scope/handoff and captures response", async () => {
    let capturedSystemOrUser = { prompt: "", system: "" };
    _setProviderFactoryForTests(async () => makeFakeProvider({
      summarize: async (text, system) => {
        capturedSystemOrUser = { prompt: text, system };
        return { output: "model said this", inTokens: 42, outTokens: 17, latencyMs: 0 };
      },
    }));

    const node = makeNode({ goal: "fix the bug", scope: ["x.ts"] });
    const res = await executeNodeLlm({
      node,
      handoffPayload: "upstream said hello",
      timeoutMs: 5000,
    });

    expect(res.ok).toBe(true);
    expect(res.output).toBe("model said this");
    expect(res.tokensIn).toBe(42);
    expect(res.tokensOut).toBe(17);
    // The full node prompt is delivered as the user message.
    expect(capturedSystemOrUser.prompt).toContain("Node goal: fix the bug");
    expect(capturedSystemOrUser.prompt).toContain("Scope (files you may reference): x.ts");
    expect(capturedSystemOrUser.prompt).toContain("Handoff context from completed predecessors: upstream said hello");
  });

  test("cap enforcement: oversized response is truncated with marker", async () => {
    // estimatedTokens=10 → cap=15 → charCap=60. Response of 200 chars must be
    // truncated to the first 60 chars + "[truncated at cap]".
    _setProviderFactoryForTests(async () => makeFakeProvider({
      summarize: async () => ({
        output: "x".repeat(200), inTokens: 1, outTokens: 1, latencyMs: 0,
      }),
    }));
    const node = makeNode({ estimatedTokens: 10 });
    const res = await executeNodeLlm({
      node,
      handoffPayload: "",
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    expect(res.output.length).toBeLessThanOrEqual(60 + "\n[truncated at cap]".length);
    expect(res.output).toContain("[truncated at cap]");
  });

  test("hard upper-bound cap of 5000 tokens regardless of estimate", async () => {
    // estimatedTokens=999_999 would compute to 1.5M tokens; clamp to 5000.
    _setProviderFactoryForTests(async () => makeFakeProvider({
      summarize: async (_t, _s, opts) => ({
        output: "short",
        inTokens: opts?.maxTokens ?? 0,
        outTokens: 0,
        latencyMs: 0,
      }),
    }));
    const res = await executeNodeLlm({
      node: makeNode({ estimatedTokens: 999_999 }),
      handoffPayload: "",
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    expect(res.tokensIn).toBe(5000);
  });

  test("provider throw surfaces as ok:false, doesn't propagate", async () => {
    _setProviderFactoryForTests(async () => makeFakeProvider({
      summarize: async () => { throw new Error("upstream 503"); },
    }));
    const res = await executeNodeLlm({
      node: makeNode(),
      handoffPayload: "",
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("upstream 503");
    expect(res.output).toBe("");
  });

  test("AbortSignal cancellation returns ok=false quickly", async () => {
    _setProviderFactoryForTests(async () => makeFakeProvider({
      summarize: async () => {
        // Simulate a slow provider that would otherwise take 5s.
        await new Promise((r) => setTimeout(r, 5000));
        return { output: "late", inTokens: 0, outTokens: 0, latencyMs: 0 };
      },
    }));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 10);
    const t0 = Date.now();
    const res = await executeNodeLlm({
      node: makeNode(),
      handoffPayload: "",
      timeoutMs: 30000,
      signal: ctl.signal,
    });
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });

  test("already-aborted signal returns immediately without calling provider", async () => {
    let providerCalled = false;
    _setProviderFactoryForTests(async () => makeFakeProvider({
      summarize: async () => {
        providerCalled = true;
        return { output: "x", inTokens: 0, outTokens: 0, latencyMs: 0 };
      },
    }));
    const ctl = new AbortController();
    ctl.abort();
    const res = await executeNodeLlm({
      node: makeNode(),
      handoffPayload: "",
      timeoutMs: 5000,
      signal: ctl.signal,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("aborted");
    expect(providerCalled).toBe(false);
  });

  test("no credentials (provider.name === 'none') returns explicit error", async () => {
    let summarizeCalled = false;
    _setProviderFactoryForTests(async () => ({
      name: "none",
      async isAvailable() { return false; },
      async summarize() {
        summarizeCalled = true;
        throw new Error("should not be called");
      },
    } as LlmProvider));

    const res = await executeNodeLlm({
      node: makeNode(),
      handoffPayload: "",
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no LLM credentials configured");
    expect(summarizeCalled).toBe(false);
  });

  test("provider factory rejection surfaces as error (no throw)", async () => {
    _setProviderFactoryForTests(async () => {
      throw new Error("factory broken");
    });
    const res = await executeNodeLlm({
      node: makeNode(),
      handoffPayload: "",
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("factory broken");
  });
});
