/**
 * orchestrate-run-llm-dispatch.test.ts — ASHLR_ORCHESTRATE_REAL_LLM dispatch.
 *
 * Coverage:
 *   1. ASHLR_ORCHESTRATE_REAL_LLM unset → stub path runs (subprocess spawned,
 *      output contains "STUB-NODE:").
 *   2. ASHLR_ORCHESTRATE_REAL_LLM=1 + mocked provider factory → LLM path runs
 *      (no subprocess, output is the mocked model content).
 *   3. Telemetry emit payload carries mode='real-llm' when the flag is set
 *      and mode='stub' otherwise.
 *
 * The companion files orchestrate-run.test.ts + orchestrate-run-parallel.test.ts
 * stay byte-identical and still cover the original stub-path matrix; this
 * file ONLY exercises the new flag-gated dispatch added in PR #95.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TaskGraph, TaskNode } from "../servers/_task-graph";
import {
  runTaskGraph,
  _setIsProSyncForTests,
  _setIsTelemetryEnabledForTests,
  _setSpawnForTests,
} from "../scripts/orchestrate-run";
import {
  _setProviderFactoryForTests,
} from "../servers/_orchestrate-executor";
import type { LlmProvider } from "../servers/_llm-providers/index";
import {
  _setOrchestrationTelemetryFetch,
  _setOrchestrationTelemetryUrl,
  _setIsTelemetryEnabledForOrchestrationEmit,
} from "../scripts/orchestrate-emit-telemetry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, deps: string[] = [], tokens = 1000): TaskNode {
  return {
    id,
    agentKind: "refactorer",
    goal: `goal for ${id}`,
    scope: [`src/${id}.ts`],
    deps,
    estimatedTokens: tokens,
  };
}

function makeGraph(nodes: TaskNode[]): TaskGraph {
  const totalTokenBudget = nodes.reduce((s, n) => s + n.estimatedTokens, 0);
  return {
    id: "g-dispatch-0001",
    goal: "dispatch test",
    scope: "/tmp/dispatch",
    tier: "pro",
    createdAt: "2027-01-01T00:00:00.000Z",
    nodes,
    handoffs: [],
    metadata: { autoExpanded: true, totalTokenBudget },
  };
}

function makeFakeProvider(impl: Partial<LlmProvider> = {}): LlmProvider {
  return {
    name: impl.name ?? "anthropic",
    async isAvailable() { return true; },
    summarize: impl.summarize ?? (async () => ({
      output: "MODEL-OUTPUT", inTokens: 11, outTokens: 7, latencyMs: 0,
    })),
  };
}

/**
 * Minimal Bun.spawn mock — same shape as the sibling tests use; lets us
 * assert that the stub path actually spawned a subprocess.
 */
function mockSpawn(
  handler: (args: { cmd: string[]; env: Record<string, string> }) => {
    stdout?: string;
  },
) {
  const calls: Array<{ cmd: string[]; env: Record<string, string> }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = ((cmd: string[], opts?: any) => {
    const env = (opts?.env ?? {}) as Record<string, string>;
    calls.push({ cmd, env });
    const res = handler({ cmd, env });
    const stdoutStr = res.stdout ?? "";
    const proc: Record<string, unknown> = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          if (stdoutStr) controller.enqueue(new TextEncoder().encode(stdoutStr));
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) { controller.close(); },
      }),
      exitCode: 0,
      kill: () => { /* noop */ },
      exited: Promise.resolve(0),
    };
    return proc as unknown as ReturnType<typeof Bun.spawn>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const ORIG_TEST_TIER = process.env.ASHLR_TEST_TIER;
const ORIG_REAL_LLM  = process.env.ASHLR_ORCHESTRATE_REAL_LLM;

beforeEach(() => {
  _setIsProSyncForTests(null);
  _setIsTelemetryEnabledForTests(() => false);
  _setSpawnForTests(null);
  _setProviderFactoryForTests(null);
  _setOrchestrationTelemetryFetch(null);
  _setOrchestrationTelemetryUrl(null);
  _setIsTelemetryEnabledForOrchestrationEmit(null);
  delete process.env.ASHLR_TEST_TIER;
  delete process.env.ASHLR_ORCHESTRATE_REAL_LLM;
});

afterEach(() => {
  _setIsProSyncForTests(null);
  _setIsTelemetryEnabledForTests(null);
  _setSpawnForTests(null);
  _setProviderFactoryForTests(null);
  _setOrchestrationTelemetryFetch(null);
  _setOrchestrationTelemetryUrl(null);
  _setIsTelemetryEnabledForOrchestrationEmit(null);
  if (ORIG_TEST_TIER === undefined) delete process.env.ASHLR_TEST_TIER;
  else process.env.ASHLR_TEST_TIER = ORIG_TEST_TIER;
  if (ORIG_REAL_LLM === undefined) delete process.env.ASHLR_ORCHESTRATE_REAL_LLM;
  else process.env.ASHLR_ORCHESTRATE_REAL_LLM = ORIG_REAL_LLM;
});

// ---------------------------------------------------------------------------
// 1. Default (flag unset) → stub path
// ---------------------------------------------------------------------------

describe("executor dispatch — default (stub) path", () => {
  test("ASHLR_ORCHESTRATE_REAL_LLM unset → subprocess spawned, output has STUB-NODE", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    // Provider must NOT be called on the stub path.
    let providerCalled = false;
    _setProviderFactoryForTests(async () => makeFakeProvider({
      summarize: async () => {
        providerCalled = true;
        return { output: "should-not-run", inTokens: 0, outTokens: 0, latencyMs: 0 };
      },
    }));

    const { fn, calls } = mockSpawn(({ env }) => ({
      stdout: `STUB-NODE: ${env.NODE_ID}\n`,
    }));
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([makeNode("node-a")]),
    });

    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(r.nodeResults[0]!.output).toContain("STUB-NODE: node-a");
    expect(providerCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Flag set → LLM path (mocked provider)
// ---------------------------------------------------------------------------

describe("executor dispatch — real-llm path", () => {
  test("ASHLR_ORCHESTRATE_REAL_LLM=1 + mocked provider → no spawn, output is model content", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    process.env.ASHLR_ORCHESTRATE_REAL_LLM = "1";

    let providerCalled = 0;
    _setProviderFactoryForTests(async () => makeFakeProvider({
      summarize: async () => {
        providerCalled++;
        return { output: "MODEL-OUTPUT", inTokens: 11, outTokens: 7, latencyMs: 0 };
      },
    }));

    // Spawn must NOT be reached when the flag is on.
    const { fn, calls } = mockSpawn(() => ({ stdout: "SHOULD-NOT-RUN" }));
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([makeNode("node-a")]),
    });

    expect(r.ok).toBe(true);
    expect(providerCalled).toBe(1);
    expect(calls.length).toBe(0); // stub-path subprocess never spawned
    expect(r.nodeResults[0]!.output).toBe("MODEL-OUTPUT");
  });
});

// ---------------------------------------------------------------------------
// 3. Telemetry payload carries mode='real-llm' vs 'stub'
// ---------------------------------------------------------------------------

describe("executor dispatch — telemetry mode field", () => {
  test("flag set: emitted telemetry payload has mode='real-llm'", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    process.env.ASHLR_ORCHESTRATE_REAL_LLM = "1";

    _setProviderFactoryForTests(async () => makeFakeProvider());

    // Force consent on for the emit and capture the POST body.
    _setIsTelemetryEnabledForOrchestrationEmit(() => true);
    _setOrchestrationTelemetryUrl("http://test.local/v1/orchestration-runs");

    let capturedBody: string | null = null;
    const fakeFetch = (async (_url: unknown, init?: { body?: string }) => {
      capturedBody = init?.body ?? null;
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;
    _setOrchestrationTelemetryFetch(fakeFetch);

    await runTaskGraph({
      graph: makeGraph([makeNode("node-a")]),
    });

    // Telemetry is fire-and-forget — give the microtask queue a beat to flush.
    await new Promise((r) => setTimeout(r, 20));

    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!) as { mode: string };
    expect(parsed.mode).toBe("real-llm");
  });

  test("flag unset: emitted telemetry payload has mode='stub'", async () => {
    process.env.ASHLR_TEST_TIER = "pro";

    const { fn } = mockSpawn(({ env }) => ({ stdout: `STUB-NODE: ${env.NODE_ID}\n` }));
    _setSpawnForTests(fn);

    _setIsTelemetryEnabledForOrchestrationEmit(() => true);
    _setOrchestrationTelemetryUrl("http://test.local/v1/orchestration-runs");

    let capturedBody: string | null = null;
    const fakeFetch = (async (_url: unknown, init?: { body?: string }) => {
      capturedBody = init?.body ?? null;
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;
    _setOrchestrationTelemetryFetch(fakeFetch);

    await runTaskGraph({
      graph: makeGraph([makeNode("node-a")]),
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!) as { mode: string };
    expect(parsed.mode).toBe("stub");
  });
});
