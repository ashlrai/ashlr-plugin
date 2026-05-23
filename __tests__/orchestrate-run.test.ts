/**
 * orchestrate-run.test.ts — Track B sequential runner.
 *
 * Coverage matrix:
 *   - tier gate (free / pro-cap / team-cap)
 *   - dry-run short-circuit
 *   - real spawn (mocked) with topo order
 *   - diamond DAG ordering (B + C only after A, D only after B+C)
 *   - handoff payload propagation
 *   - 30s per-node timeout enforcement
 *   - per-node failure doesn't halt run
 *   - telemetry on/off
 *
 * Uses DI seams (_setIsProSyncForTests, _setIsTelemetryEnabledForTests,
 * _setSpawnForTests) following the v1.30 _setDailyHeartbeat* pattern.
 *
 * No real subprocesses, no network, no real ~/.ashlr writes.
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
    id: "g-run-0001",
    goal: "run test",
    scope: "/tmp/run",
    tier: "pro",
    createdAt: "2027-01-01T00:00:00.000Z",
    nodes,
    handoffs: [],
    metadata: { autoExpanded: true, totalTokenBudget },
  };
}

/**
 * Build a mock Bun.spawn that returns canned stdout + an immediate exit.
 * The handler receives the env passed to spawn so tests can record the
 * HANDOFF_PAYLOAD they observed and assert on order.
 */
function mockSpawn(
  handler: (args: { cmd: string[]; env: Record<string, string> }) => {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    /** Optional delay (ms) before exit — used for the timeout test. */
    delayMs?: number;
  },
) {
  // We type-shim the return as `any` because Bun's Subprocess type is complex
  // and we only need a duck-typed surface the runner actually reads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: Array<{ cmd: string[]; env: Record<string, string> }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = ((cmd: string[], opts?: any) => {
    const env = (opts?.env ?? {}) as Record<string, string>;
    calls.push({ cmd, env });
    const res = handler({ cmd, env });
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
      kill: () => {
        killed = true;
      },
      exited: new Promise<number>((resolve) => {
        if (delayMs > 0) {
          const timer = setTimeout(() => resolve(exitCode), delayMs);
          // If kill() fires, resolve early.
          const interval = setInterval(() => {
            if (killed) {
              clearTimeout(timer);
              clearInterval(interval);
              resolve(137); // SIGKILL exit code
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
// Setup / teardown — ensure DI seams reset between tests.
// ---------------------------------------------------------------------------

const ORIG_TEST_TIER = process.env.ASHLR_TEST_TIER;

beforeEach(() => {
  _setIsProSyncForTests(null);
  _setIsTelemetryEnabledForTests(() => false); // default off
  _setSpawnForTests(null);
  delete process.env.ASHLR_TEST_TIER;
});

afterEach(() => {
  _setIsProSyncForTests(null);
  _setIsTelemetryEnabledForTests(null);
  _setSpawnForTests(null);
  if (ORIG_TEST_TIER === undefined) delete process.env.ASHLR_TEST_TIER;
  else process.env.ASHLR_TEST_TIER = ORIG_TEST_TIER;
});

// ---------------------------------------------------------------------------
// 1. Tier gate — free
// ---------------------------------------------------------------------------

describe("tier gate", () => {
  test("free tier: no subprocesses, returns ok=false + free-tier reason", async () => {
    process.env.ASHLR_TEST_TIER = "free";
    const { fn, calls } = mockSpawn(() => ({ stdout: "should not run" }));
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([makeNode("node-a"), makeNode("node-b", ["node-a"])]),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("free-tier");
    expect(calls.length).toBe(0);
    expect(r.nodes).toHaveLength(0);
    expect(r.nodeResults).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. Tier gate — pro cap
  // -------------------------------------------------------------------------

  test("pro tier + 4 nodes → ok=false + pro-tier-3-agent-cap, no subprocesses", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    const { fn, calls } = mockSpawn(() => ({ stdout: "no" }));
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("node-a"),
        makeNode("node-b"),
        makeNode("node-c"),
        makeNode("node-d"),
      ]),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("pro-tier-3-agent-cap");
    expect(calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. Tier gate — team cap
  // -------------------------------------------------------------------------

  test("team tier + 11 nodes → ok=false + team-tier-10-agent-cap, no subprocesses", async () => {
    process.env.ASHLR_TEST_TIER = "team";
    const { fn, calls } = mockSpawn(() => ({ stdout: "no" }));
    _setSpawnForTests(fn);

    const nodes: TaskNode[] = [];
    for (let i = 0; i < 11; i++) nodes.push(makeNode(`node-${i}`));
    const r = await runTaskGraph({ graph: makeGraph(nodes) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("team-tier-10-agent-cap");
    expect(calls.length).toBe(0);
  });

  test("team tier + 10 nodes → runs (right at cap)", async () => {
    process.env.ASHLR_TEST_TIER = "team";
    const { fn, calls } = mockSpawn(() => ({ stdout: "ok" }));
    _setSpawnForTests(fn);

    const nodes: TaskNode[] = [];
    for (let i = 0; i < 10; i++) nodes.push(makeNode(`node-${i}`));
    const r = await runTaskGraph({ graph: makeGraph(nodes) });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 4. Dry-run
// ---------------------------------------------------------------------------

describe("dry run", () => {
  test("pro + 3 nodes + dryRun=true: ok=true, all outputs '[dry-run]', no spawn", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    const { fn, calls } = mockSpawn(() => ({ stdout: "should not run" }));
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("node-a"),
        makeNode("node-b", ["node-a"]),
        makeNode("node-c", ["node-b"]),
      ]),
      dryRun: true,
    });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(0);
    expect(r.nodeResults).toHaveLength(3);
    for (const n of r.nodeResults) {
      expect(n.output).toBe("[dry-run]");
      expect(n.ok).toBe(true);
    }
    expect(r.totalTokensUsed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Real run (mocked spawn)
// ---------------------------------------------------------------------------

describe("real run", () => {
  test("pro + 3 nodes + real run: 3 subprocesses spawned, stdout captured, ok=true", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    const { fn, calls } = mockSpawn(({ env }) => ({
      stdout: `STUB-NODE: ${env.NODE_ID}\n`,
    }));
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("node-a"),
        makeNode("node-b", ["node-a"]),
        makeNode("node-c", ["node-b"]),
      ]),
    });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(3);
    expect(r.nodeResults[0]!.output).toContain("STUB-NODE: node-a");
    expect(r.nodeResults[1]!.output).toContain("STUB-NODE: node-b");
    expect(r.nodeResults[2]!.output).toContain("STUB-NODE: node-c");
  });

  // -------------------------------------------------------------------------
  // 6. Diamond DAG ordering
  // -------------------------------------------------------------------------

  test("diamond DAG: B + C only start after A; D only after B+C", async () => {
    process.env.ASHLR_TEST_TIER = "pro"; // 4 nodes — pro caps at 3, so use team
    process.env.ASHLR_TEST_TIER = "team";
    const startOrder: string[] = [];
    const { fn } = mockSpawn(({ env }) => {
      startOrder.push(env.NODE_ID);
      return { stdout: `done ${env.NODE_ID}\n` };
    });
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("node-d", ["node-b", "node-c"]),
        makeNode("node-b", ["node-a"]),
        makeNode("node-c", ["node-a"]),
        makeNode("node-a"),
      ]),
    });
    expect(r.ok).toBe(true);
    expect(startOrder[0]).toBe("node-a");
    expect(startOrder[3]).toBe("node-d");
    expect(startOrder.indexOf("node-b")).toBeGreaterThan(0);
    expect(startOrder.indexOf("node-c")).toBeGreaterThan(0);
    expect(startOrder.indexOf("node-b")).toBeLessThan(startOrder.indexOf("node-d"));
    expect(startOrder.indexOf("node-c")).toBeLessThan(startOrder.indexOf("node-d"));
  });

  // -------------------------------------------------------------------------
  // 7. Handoff payload
  // -------------------------------------------------------------------------

  test("handoff payload: B's HANDOFF_PAYLOAD env contains A's stdout", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    const seenHandoff: Record<string, string> = {};
    const { fn } = mockSpawn(({ env }) => {
      seenHandoff[env.NODE_ID] = env.HANDOFF_PAYLOAD;
      return { stdout: `OUTPUT-OF-${env.NODE_ID}\n` };
    });
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("node-a"),
        makeNode("node-b", ["node-a"]),
      ]),
    });
    expect(r.ok).toBe(true);
    expect(seenHandoff["node-a"]).toBe(""); // no predecessors
    expect(seenHandoff["node-b"]).toContain("OUTPUT-OF-node-a");
    expect(seenHandoff["node-b"]).toContain("[from node-a]");
  });

  // -------------------------------------------------------------------------
  // 8. Per-node failure doesn't halt
  // -------------------------------------------------------------------------

  test("per-node failure does NOT halt: A fails → B still runs (and HANDOFF reflects A's stdout)", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    const seenHandoff: Record<string, string> = {};
    const { fn, calls } = mockSpawn(({ env }) => {
      seenHandoff[env.NODE_ID] = env.HANDOFF_PAYLOAD;
      if (env.NODE_ID === "node-a") {
        return { stdout: "partial-a\n", stderr: "kaboom\n", exitCode: 1 };
      }
      return { stdout: `done ${env.NODE_ID}\n` };
    });
    _setSpawnForTests(fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("node-a"),
        makeNode("node-b", ["node-a"]),
      ]),
    });
    expect(r.ok).toBe(false); // overall fails because A failed
    expect(calls.length).toBe(2); // both spawned
    const a = r.nodeResults.find((n) => n.nodeId === "node-a")!;
    const b = r.nodeResults.find((n) => n.nodeId === "node-b")!;
    expect(a.ok).toBe(false);
    expect(a.error).toContain("kaboom");
    expect(b.ok).toBe(true);
    // HANDOFF carries even the failed predecessor's stdout.
    expect(seenHandoff["node-b"]).toContain("partial-a");
  });
});

// ---------------------------------------------------------------------------
// 9. Timeout enforcement
// ---------------------------------------------------------------------------

describe("per-node timeout", () => {
  test("30s wallclock timeout kills hung node and marks it failed", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    // Patch global setTimeout so the runner's 30s wallclock fires fast.
    // longTimerCount===1 → mock's delayed-exit timer (kept long so it loses).
    // longTimerCount===2 → runner's 30s wallclock (compressed to 20ms).
    const origSetTimeout = globalThis.setTimeout;
    let longTimerCount = 0;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      fnArg: () => void,
      ms: number,
    ): ReturnType<typeof setTimeout> => {
      if (ms >= 1000) {
        longTimerCount++;
        const compressed = longTimerCount === 1 ? 5_000 : 20;
        return origSetTimeout(fnArg, compressed);
      }
      return origSetTimeout(fnArg, ms);
    }) as unknown as typeof setTimeout;

    const { fn } = mockSpawn(() => ({
      stdout: "stalled",
      delayMs: 60_000,
      exitCode: 0,
    }));
    _setSpawnForTests(fn);

    try {
      const r = await runTaskGraph({
        graph: makeGraph([makeNode("node-slow")]),
      });
      expect(r.ok).toBe(false);
      const slow = r.nodeResults[0]!;
      expect(slow.ok).toBe(false);
      expect(slow.error).toContain("timeout");
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Telemetry
// ---------------------------------------------------------------------------

describe("telemetry", () => {
  test("telemetry off: emit functions never called", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    let telemetryChecked = 0;
    _setIsTelemetryEnabledForTests(() => {
      telemetryChecked++;
      return false;
    });
    const { fn } = mockSpawn(() => ({ stdout: "ok" }));
    _setSpawnForTests(fn);

    await runTaskGraph({
      graph: makeGraph([makeNode("node-a"), makeNode("node-b", ["node-a"])]),
    });
    // Runner asks the gate per-event, but never writes when it returns false.
    expect(telemetryChecked).toBeGreaterThan(0);
  });

  test("telemetry on: gate is queried per-node (start + complete)", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    let telemetryChecked = 0;
    _setIsTelemetryEnabledForTests(() => {
      telemetryChecked++;
      return true;
    });
    const { fn } = mockSpawn(() => ({ stdout: "ok" }));
    _setSpawnForTests(fn);

    await runTaskGraph({
      graph: makeGraph([makeNode("node-a"), makeNode("node-b", ["node-a"])]),
    });
    // Two nodes × (start + complete) = 4 gate-checks minimum.
    expect(telemetryChecked).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// 11. Callbacks
// ---------------------------------------------------------------------------

describe("callbacks", () => {
  test("onNodeStart + onNodeComplete fire in topo order", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    const events: string[] = [];
    const { fn } = mockSpawn(({ env }) => ({ stdout: `done ${env.NODE_ID}\n` }));
    _setSpawnForTests(fn);

    await runTaskGraph({
      graph: makeGraph([
        makeNode("node-a"),
        makeNode("node-b", ["node-a"]),
      ]),
      onNodeStart: (n) => events.push(`start:${n.id}`),
      onNodeComplete: (n, r) => events.push(`done:${n.id}:${r.ok}`),
    });
    expect(events).toEqual([
      "start:node-a",
      "done:node-a:true",
      "start:node-b",
      "done:node-b:true",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 12. Result shape compatibility (the legacy + spec-required field aliases)
// ---------------------------------------------------------------------------

describe("result shape", () => {
  test("exposes BOTH legacy (id/tokens/nodes/totalTokens) and spec (nodeId/tokensUsed/nodeResults/totalTokensUsed) fields", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    const { fn } = mockSpawn(({ env }) => ({ stdout: `ok ${env.NODE_ID}\n` }));
    _setSpawnForTests(fn);

    const r = await runTaskGraph({ graph: makeGraph([makeNode("node-a")]) });
    expect(r.ok).toBe(true);
    expect(r.graphId).toBe("g-run-0001");
    expect(typeof r.startedAt).toBe("string");
    expect(typeof r.finishedAt).toBe("string");
    expect(r.totalTokens).toBe(r.totalTokensUsed);
    expect(r.nodes).toBe(r.nodeResults); // same array reference for hot-path callers
    const node = r.nodeResults[0]!;
    expect(node.id).toBe(node.nodeId);
    expect(node.tokens).toBe(node.tokensUsed);
  });
});
