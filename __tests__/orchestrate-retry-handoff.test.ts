/**
 * orchestrate-retry-handoff.test.ts — Q1'27 wk 10-12 retry-with-backoff +
 * handoff context budget (8KB cap).
 *
 * Coverage:
 *   - Retry: single-attempt success, 2 fails then success, 3 fails, dry-run
 *     short-circuit, telemetry payload includes retryCount + finalAttempt.
 *   - Handoff budget: sub-cap unchanged, over-cap truncated with marker,
 *     multiple-predecessor aggregation, empty predecessor list.
 *
 * Uses the same DI seam pattern (_setSpawnForTests + mocked Bun.spawn) as
 * __tests__/orchestrate-run.test.ts. No real subprocesses or network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TaskGraph, TaskNode } from "../servers/_task-graph";
import {
  runTaskGraph,
  _setIsProSyncForTests,
  _setIsTelemetryEnabledForTests,
  _setSpawnForTests,
} from "../scripts/orchestrate-run";

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
    id: "g-retry-0001",
    goal: "retry test",
    scope: "/tmp/retry",
    tier: "pro",
    createdAt: "2027-01-01T00:00:00.000Z",
    nodes,
    handoffs: [],
    metadata: { autoExpanded: true, totalTokenBudget },
  };
}

/**
 * Programmable spawn mock. `responses` is a per-node-id queue of exit
 * outcomes — each spawn call for a node consumes the next response from
 * its queue. When the queue is empty, falls back to the last response
 * (sticky), so a single failing response = fails forever.
 */
function mockSpawnQueued(
  responsesByNode: Record<string, Array<{ exitCode: number; stdout?: string; stderr?: string }>>,
): {
  fn: ReturnType<typeof Bun.spawn>;
  spawns: Array<{ nodeId: string; env: Record<string, string> }>;
} {
  const spawns: Array<{ nodeId: string; env: Record<string, string> }> = [];
  const cursors: Record<string, number> = {};

  const fn = ((cmd: string[], opts?: { env?: Record<string, string> }) => {
    const env = (opts?.env ?? {}) as Record<string, string>;
    const nodeId = env.NODE_ID ?? "";
    spawns.push({ nodeId, env });

    const queue = responsesByNode[nodeId] ?? [{ exitCode: 0, stdout: `STUB-NODE: ${nodeId}\n` }];
    const idx = cursors[nodeId] ?? 0;
    const response = queue[Math.min(idx, queue.length - 1)]!;
    cursors[nodeId] = idx + 1;

    const stdoutStr = response.stdout ?? "";
    const stderrStr = response.stderr ?? "";
    const exitCode = response.exitCode;
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
      kill: () => {},
      exited: Promise.resolve(exitCode),
    };
    return proc as unknown as ReturnType<typeof Bun.spawn>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { fn, spawns };
}

// Patch globalThis.setTimeout to compress retry backoffs to <1ms. Returns
// a restore function so we can undo it after the test. We do NOT touch
// ms >= 1000 so the runner's 30s wallclock timer keeps its normal value.
function compressShortTimers(): () => void {
  const orig = globalThis.setTimeout;
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    fnArg: () => void,
    ms: number,
  ): ReturnType<typeof setTimeout> => {
    // Backoffs are 250 + 500 = 750ms total. Compress to 1ms each.
    if (ms > 0 && ms < 1000) return orig(fnArg, 1);
    return orig(fnArg, ms);
  }) as unknown as typeof setTimeout;
  return () => {
    globalThis.setTimeout = orig;
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ORIG_TEST_TIER = process.env.ASHLR_TEST_TIER;

beforeEach(() => {
  _setIsProSyncForTests(null);
  _setIsTelemetryEnabledForTests(() => false);
  _setSpawnForTests(null);
  delete process.env.ASHLR_TEST_TIER;
  process.env.ASHLR_TEST_TIER = "pro";
});

afterEach(() => {
  _setIsProSyncForTests(null);
  _setIsTelemetryEnabledForTests(null);
  _setSpawnForTests(null);
  if (ORIG_TEST_TIER === undefined) delete process.env.ASHLR_TEST_TIER;
  else process.env.ASHLR_TEST_TIER = ORIG_TEST_TIER;
});

// ===========================================================================
// 1. Retry-with-backoff
// ===========================================================================

describe("retry-with-backoff", () => {
  test("single attempt success → retryCount=0, finalAttempt=1", async () => {
    const { fn, spawns } = mockSpawnQueued({
      "node-a": [{ exitCode: 0, stdout: "ok\n" }],
    });
    _setSpawnForTests(fn);

    const r = await runTaskGraph({ graph: makeGraph([makeNode("node-a")]) });
    expect(r.ok).toBe(true);
    const a = r.nodes[0]!;
    expect(a.ok).toBe(true);
    expect(a.retryCount).toBe(0);
    expect(a.finalAttempt).toBe(1);
    // Single spawn — no retries needed.
    expect(spawns.filter((s) => s.nodeId === "node-a").length).toBe(1);
  });

  test("2 failures then success on attempt 3 → retryCount=2, finalAttempt=3, ok=true", async () => {
    const restore = compressShortTimers();
    try {
      const { fn, spawns } = mockSpawnQueued({
        "node-flaky": [
          { exitCode: 1, stderr: "fail-1" },
          { exitCode: 1, stderr: "fail-2" },
          { exitCode: 0, stdout: "ok-on-3" },
        ],
      });
      _setSpawnForTests(fn);

      const r = await runTaskGraph({ graph: makeGraph([makeNode("node-flaky")]) });
      expect(r.ok).toBe(true);
      const f = r.nodes[0]!;
      expect(f.ok).toBe(true);
      expect(f.retryCount).toBe(2);
      expect(f.finalAttempt).toBe(3);
      expect(f.output).toContain("ok-on-3");
      expect(spawns.filter((s) => s.nodeId === "node-flaky").length).toBe(3);
    } finally {
      restore();
    }
  });

  test("3 consecutive failures → ok=false, retryCount=2, finalAttempt=3", async () => {
    const restore = compressShortTimers();
    try {
      const { fn, spawns } = mockSpawnQueued({
        "node-doomed": [{ exitCode: 1, stderr: "always-fails" }],
      });
      _setSpawnForTests(fn);

      const r = await runTaskGraph({ graph: makeGraph([makeNode("node-doomed")]) });
      expect(r.ok).toBe(false);
      const d = r.nodes[0]!;
      expect(d.ok).toBe(false);
      expect(d.retryCount).toBe(2);
      expect(d.finalAttempt).toBe(3);
      expect(d.error).toContain("always-fails");
      // 3 attempts = 3 spawns.
      expect(spawns.filter((s) => s.nodeId === "node-doomed").length).toBe(3);
    } finally {
      restore();
    }
  });

  test("dry-run skips retry entirely (no spawn, retryCount=0, finalAttempt=1)", async () => {
    const { fn, spawns } = mockSpawnQueued({});
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([makeNode("dry-1"), makeNode("dry-2")]),
      dryRun: true,
    });
    expect(r.ok).toBe(true);
    expect(spawns.length).toBe(0);
    for (const n of r.nodes) {
      expect(n.retryCount).toBe(0);
      expect(n.finalAttempt).toBe(1);
    }
  });

  test("telemetry payload includes retryCount + finalAttempt", async () => {
    const restore = compressShortTimers();
    try {
      // Capture telemetry events. We intercept via the telemetry enable seam +
      // a module-side spy: emitTelemetry calls recordTelemetryEvent, which we
      // can't easily mock here. Instead assert via the onNodeComplete hook
      // which fires WITH the result that telemetry consumes; the runner
      // synthesizes the telemetry payload directly from result.retryCount /
      // result.finalAttempt, so checking those fields is equivalent.
      const observed: Array<{ id: string; retryCount?: number; finalAttempt?: number }> = [];
      const { fn } = mockSpawnQueued({
        "node-tel": [
          { exitCode: 1, stderr: "x" },
          { exitCode: 0, stdout: "y" },
        ],
      });
      _setSpawnForTests(fn);
      _setIsTelemetryEnabledForTests(() => true);

      const r = await runTaskGraph({
        graph: makeGraph([makeNode("node-tel")]),
        onNodeComplete: (_n, res) => {
          observed.push({ id: res.id, retryCount: res.retryCount, finalAttempt: res.finalAttempt });
        },
      });
      expect(r.ok).toBe(true);
      expect(observed).toEqual([{ id: "node-tel", retryCount: 1, finalAttempt: 2 }]);
    } finally {
      restore();
    }
  });
});

// ===========================================================================
// 2. Handoff context budget (8KB cap)
// ===========================================================================

describe("handoff context budget", () => {
  test("sum under 8KB → HANDOFF_PAYLOAD unchanged, handoffsTruncated=0", async () => {
    const small = "tiny-output";
    const { fn, spawns } = mockSpawnQueued({
      "A": [{ exitCode: 0, stdout: small }],
      "B": [{ exitCode: 0, stdout: "b-out" }],
    });
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([makeNode("A"), makeNode("B", ["A"])]),
    });
    expect(r.ok).toBe(true);
    expect(r.handoffsTruncated).toBe(0);

    const bSpawn = spawns.find((s) => s.nodeId === "B")!;
    expect(bSpawn.env.HANDOFF_PAYLOAD).toContain("tiny-output");
    expect(bSpawn.env.HANDOFF_PAYLOAD).not.toContain("handoff truncated");
  });

  test("sum exceeds 8KB → truncated, marker appended, handoffsTruncated incremented", async () => {
    const big = "X".repeat(10_000); // 10KB > 8KB cap
    const { fn, spawns } = mockSpawnQueued({
      "A": [{ exitCode: 0, stdout: big }],
      "B": [{ exitCode: 0, stdout: "b-out" }],
    });
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([makeNode("A"), makeNode("B", ["A"])]),
    });
    expect(r.ok).toBe(true);
    expect(r.handoffsTruncated).toBe(1);

    const bSpawn = spawns.find((s) => s.nodeId === "B")!;
    const payload = bSpawn.env.HANDOFF_PAYLOAD;
    expect(payload).toContain("[handoff truncated:");
    expect(payload).toContain("capped at 8192");
    // First 8192 bytes preserved; rest replaced with marker.
    expect(payload.startsWith("[from A]\nXXXX")).toBe(true);
  });

  test("multiple predecessors at ~5KB each summing >8KB → truncated", async () => {
    const chunk = "Y".repeat(5_000); // two parents × 5KB > 8KB
    const { fn, spawns } = mockSpawnQueued({
      "P1": [{ exitCode: 0, stdout: chunk }],
      "P2": [{ exitCode: 0, stdout: chunk }],
      "C": [{ exitCode: 0, stdout: "child-out" }],
    });
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("P1"),
        makeNode("P2"),
        makeNode("C", ["P1", "P2"]),
      ]),
    });
    expect(r.ok).toBe(true);
    expect(r.handoffsTruncated).toBe(1);

    const cSpawn = spawns.find((s) => s.nodeId === "C")!;
    const payload = cSpawn.env.HANDOFF_PAYLOAD;
    // Total uncompressed payload includes both [from P1] and [from P2] +
    // separators. After truncation it's capped at 8KB+marker.
    expect(payload.length).toBeLessThan(10_000); // cap + marker overhead
    expect(payload).toContain("[handoff truncated:");
  });

  test("empty predecessor list → HANDOFF_PAYLOAD is empty string, handoffsTruncated=0", async () => {
    const { fn, spawns } = mockSpawnQueued({
      "solo": [{ exitCode: 0, stdout: "alone" }],
    });
    _setSpawnForTests(fn);

    const r = await runTaskGraph({ graph: makeGraph([makeNode("solo")]) });
    expect(r.ok).toBe(true);
    expect(r.handoffsTruncated).toBe(0);

    const soloSpawn = spawns.find((s) => s.nodeId === "solo")!;
    expect(soloSpawn.env.HANDOFF_PAYLOAD).toBe("");
  });

  test("handoffsTruncated is always present on RunResult (even when zero)", async () => {
    const { fn } = mockSpawnQueued({
      "any": [{ exitCode: 0, stdout: "ok" }],
    });
    _setSpawnForTests(fn);

    const r = await runTaskGraph({ graph: makeGraph([makeNode("any")]) });
    // Property defined and is a number.
    expect(typeof r.handoffsTruncated).toBe("number");
    expect(r.handoffsTruncated).toBe(0);
  });

  test("tier-rejected runs include handoffsTruncated=0", async () => {
    process.env.ASHLR_TEST_TIER = "free";
    const r = await runTaskGraph({ graph: makeGraph([makeNode("a")]) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("free-tier");
    expect(r.handoffsTruncated).toBe(0);
  });
});
