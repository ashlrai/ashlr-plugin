/**
 * orchestrate-emit-telemetry.test.ts — Q1'27 plugin-side emit test.
 *
 * Coverage:
 *   1. Consent off → no POST fires.
 *   2. Consent on → POST fires to the override URL with method=POST + JSON.
 *   3. Payload shape: all required fields present, derived correctly.
 *   4. fail_count derived from nodeResults.
 *   5. Network failure swallowed silently (no throw, no unhandled rejection).
 *   6. Runner integration: runTaskGraph() invokes the emit via the runner wiring.
 *   7. Mode='stub' is passed by the MVP runner.
 *
 * No real network, no real ~/.ashlr writes — everything is gated via the
 * exported test seams.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TaskGraph, TaskNode } from "../servers/_task-graph";
import {
  buildOrchestrationRunPayload,
  emitOrchestrationRunTelemetry,
  _setOrchestrationTelemetryUrl,
  _setOrchestrationTelemetryFetch,
  _setIsTelemetryEnabledForOrchestrationEmit,
  type OrchestrationRunTelemetryPayload,
} from "../scripts/orchestrate-emit-telemetry";
import type { RunResult } from "../scripts/orchestrate-run";
import {
  runTaskGraph,
  _setIsProSyncForTests,
  _setIsTelemetryEnabledForTests,
  _setSpawnForTests,
} from "../scripts/orchestrate-run";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, deps: string[] = []): TaskNode {
  return {
    id,
    agentKind: "refactorer",
    goal: `do ${id}`,
    scope: [`src/${id}.ts`],
    deps,
    estimatedTokens: 1000,
  };
}

function makeGraph(nodes: TaskNode[], goal = "test orchestration"): TaskGraph {
  return {
    id: "g-emit-test",
    goal,
    scope: "/tmp/run",
    tier: "pro",
    createdAt: "2027-01-01T00:00:00.000Z",
    nodes,
    handoffs: [],
    metadata: { autoExpanded: true, totalTokenBudget: nodes.length * 1000 },
  };
}

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    ok: true,
    graphId: "g-emit-test",
    startedAt: "2027-01-01T00:00:00.000Z",
    finishedAt: "2027-01-01T00:00:42.000Z",
    totalDurationMs: 42_000,
    totalTokens: 3000,
    totalTokensUsed: 3000,
    nodes: [
      { id: "n1", nodeId: "n1", ok: true, durationMs: 100, tokens: 1000, tokensUsed: 1000, output: "ok" },
      { id: "n2", nodeId: "n2", ok: true, durationMs: 100, tokens: 1000, tokensUsed: 1000, output: "ok" },
      { id: "n3", nodeId: "n3", ok: true, durationMs: 100, tokens: 1000, tokensUsed: 1000, output: "ok" },
    ],
    nodeResults: [
      { id: "n1", nodeId: "n1", ok: true, durationMs: 100, tokens: 1000, tokensUsed: 1000, output: "ok" },
      { id: "n2", nodeId: "n2", ok: true, durationMs: 100, tokens: 1000, tokensUsed: 1000, output: "ok" },
      { id: "n3", nodeId: "n3", ok: true, durationMs: 100, tokens: 1000, tokensUsed: 1000, output: "ok" },
    ],
    maxConcurrentWindows: [],
    handoffsTruncated: 0,
    ...overrides,
  };
}

interface CapturedFetch {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  fn: typeof fetch;
}

function captureFetch(opts: { reject?: boolean } = {}): CapturedFetch {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (opts.reject) {
      return Promise.reject(new Error("network down"));
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 202 }));
  }) as unknown as typeof fetch;
  return { calls, fn };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const ORIG_TEST_TIER = process.env.ASHLR_TEST_TIER;

beforeEach(() => {
  _setOrchestrationTelemetryUrl("http://mock-host/v1/orchestration-runs");
  _setOrchestrationTelemetryFetch(null);
  _setIsTelemetryEnabledForOrchestrationEmit(null);
  _setIsProSyncForTests(null);
  _setIsTelemetryEnabledForTests(() => false);
  _setSpawnForTests(null);
  delete process.env.ASHLR_TEST_TIER;
});

afterEach(() => {
  _setOrchestrationTelemetryUrl(null);
  _setOrchestrationTelemetryFetch(null);
  _setIsTelemetryEnabledForOrchestrationEmit(null);
  _setIsProSyncForTests(null);
  _setIsTelemetryEnabledForTests(null);
  _setSpawnForTests(null);
  if (ORIG_TEST_TIER === undefined) delete process.env.ASHLR_TEST_TIER;
  else process.env.ASHLR_TEST_TIER = ORIG_TEST_TIER;
});

// ---------------------------------------------------------------------------
// 1. Consent off → no POST
// ---------------------------------------------------------------------------

describe("consent gate", () => {
  test("consent off → no fetch call fires", async () => {
    _setIsTelemetryEnabledForOrchestrationEmit(() => false);
    const cap = captureFetch();
    _setOrchestrationTelemetryFetch(cap.fn);

    await emitOrchestrationRunTelemetry(makeResult(), makeGraph([makeNode("n1")]), "stub");
    // Give fire-and-forget microtask a chance to run.
    await new Promise((r) => setTimeout(r, 5));
    expect(cap.calls.length).toBe(0);
  });

  test("consent on → POST fires with method=POST and JSON body", async () => {
    _setIsTelemetryEnabledForOrchestrationEmit(() => true);
    const cap = captureFetch();
    _setOrchestrationTelemetryFetch(cap.fn);

    await emitOrchestrationRunTelemetry(makeResult(), makeGraph([makeNode("n1")]), "stub");
    await new Promise((r) => setTimeout(r, 10));
    expect(cap.calls.length).toBe(1);
    const call = cap.calls[0]!;
    expect(call.url).toBe("http://mock-host/v1/orchestration-runs");
    expect(call.init?.method).toBe("POST");
    expect((call.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(call.init?.body as string) as OrchestrationRunTelemetryPayload;
    expect(body.graph_id).toBe("g-emit-test");
    expect(body.goal).toBe("test orchestration");
    expect(body.tier).toBe("pro");
    expect(body.mode).toBe("stub");
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Payload shape
// ---------------------------------------------------------------------------

describe("payload shape", () => {
  test("all required fields present, derived correctly from RunResult + TaskGraph", () => {
    const graph = makeGraph([makeNode("n1"), makeNode("n2"), makeNode("n3")], "ship orch telemetry");
    const result = makeResult({ totalDurationMs: 99_999, totalTokensUsed: 4321 });
    const payload = buildOrchestrationRunPayload(result, graph, "real-llm");

    expect(typeof payload.identity_hash).toBe("string");
    expect(payload.identity_hash.length).toBe(64); // sha256 hex
    expect(payload.graph_id).toBe("g-emit-test");
    expect(payload.goal).toBe("ship orch telemetry");
    expect(payload.tier).toBe("pro");
    expect(payload.mode).toBe("real-llm");
    expect(payload.started_at).toBe("2027-01-01T00:00:00.000Z");
    expect(payload.finished_at).toBe("2027-01-01T00:00:42.000Z");
    expect(payload.duration_ms).toBe(99_999);
    expect(payload.node_count).toBe(3);
    expect(payload.fail_count).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.total_tokens_in).toBe(4321);
    expect(payload.total_tokens_out).toBe(0);
  });

  test("fail_count derived from nodeResults.ok=false", () => {
    const failResult = makeResult({
      ok: false,
      nodeResults: [
        { id: "n1", nodeId: "n1", ok: true, durationMs: 1, tokens: 100, tokensUsed: 100 },
        { id: "n2", nodeId: "n2", ok: false, durationMs: 1, tokens: 0, tokensUsed: 0, error: "boom" },
        { id: "n3", nodeId: "n3", ok: false, durationMs: 1, tokens: 0, tokensUsed: 0, error: "splat" },
      ],
    });
    const payload = buildOrchestrationRunPayload(failResult, makeGraph([makeNode("n1")]), "stub");
    expect(payload.ok).toBe(false);
    expect(payload.fail_count).toBe(2);
    expect(payload.node_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Network failure swallowed
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("network failure does NOT throw or propagate to caller", async () => {
    _setIsTelemetryEnabledForOrchestrationEmit(() => true);
    const cap = captureFetch({ reject: true });
    _setOrchestrationTelemetryFetch(cap.fn);

    // Should not throw.
    await expect(
      emitOrchestrationRunTelemetry(makeResult(), makeGraph([makeNode("n1")]), "stub"),
    ).resolves.toBeUndefined();

    // Let the rejected promise settle so any unhandled rejection would have fired.
    await new Promise((r) => setTimeout(r, 10));
    expect(cap.calls.length).toBe(1); // attempt did fire
  });
});

// ---------------------------------------------------------------------------
// 4. Runner integration
// ---------------------------------------------------------------------------

describe("runner integration", () => {
  test("runTaskGraph triggers the emit at the end of a successful run (mode='stub')", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    _setIsTelemetryEnabledForOrchestrationEmit(() => true);

    const cap = captureFetch();
    _setOrchestrationTelemetryFetch(cap.fn);

    // Mock spawn so the runner can actually complete without subprocesses.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockSpawn = ((cmd: string[], opts?: any) => {
      const env = (opts?.env ?? {}) as Record<string, string>;
      const stdoutStr = `STUB-NODE: ${env.NODE_ID}\n`;
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(stdoutStr));
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        exitCode: 0,
        kill: () => {},
        exited: Promise.resolve(0),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSpawnForTests(mockSpawn);

    const result = await runTaskGraph({
      graph: makeGraph([makeNode("n1"), makeNode("n2", ["n1"])]),
    });
    expect(result.ok).toBe(true);

    // Give the fire-and-forget POST a microtask to enqueue.
    await new Promise((r) => setTimeout(r, 10));
    expect(cap.calls.length).toBe(1);
    const body = JSON.parse(cap.calls[0]!.init?.body as string) as OrchestrationRunTelemetryPayload;
    expect(body.mode).toBe("stub");
    expect(body.node_count).toBe(2);
    expect(body.fail_count).toBe(0);
    expect(body.ok).toBe(true);
  });
});
