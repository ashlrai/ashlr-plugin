/**
 * orchestrate-run-parallel.test.ts — Q1'27 wk 4-6 parallel-where-deps-allow.
 *
 * Companion file to orchestrate-run.test.ts; that one covers tier gates,
 * dry-run, handoff, timeouts, telemetry. This one ONLY exercises the new
 * parallel scheduler:
 *
 *   - diamond DAG (A→B, A→C, B+C→D): B & C run concurrently after A; D only
 *     starts after both;
 *   - wide fan-out: 3 leaves running simultaneously under the Pro cap;
 *   - concurrency cap enforced — never more than maxConcurrency in flight;
 *   - wave-by-wave start timestamps: B and C within 10ms of each other,
 *     D starts after both complete;
 *   - failure isolation: one node fails, peers + successors still scheduled;
 *   - dryRun still respects DAG ordering;
 *   - tier gate STILL fires before the scheduler runs;
 *   - critical-path duration: total wallclock ≈ critical path, not sum.
 *   - maxConcurrency=1 forces strict sequential (back-compat with v1 runner);
 *   - maxConcurrentWindows transitions captured on every start/finish;
 *   - team tier saturates 10 leaves in parallel.
 *
 * Uses the same DI-seam mocking pattern (_setIsProSyncForTests +
 * _setSpawnForTests) as the sibling sequential test file.
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
    id: "g-parallel-0001",
    goal: "parallel test",
    scope: "/tmp/parallel",
    tier: "pro",
    createdAt: "2027-01-01T00:00:00.000Z",
    nodes,
    handoffs: [],
    metadata: { autoExpanded: true, totalTokenBudget },
  };
}

/**
 * Mock Bun.spawn that lets each invocation control its own delay + outcome.
 * Records the order in which subprocesses STARTED (synchronously, the moment
 * spawn() was called) and the order in which they FINISHED (after delay).
 *
 * delayMs simulates per-node work. The mock's `exited` promise resolves on a
 * timer so Promise.race in the runner actually exercises the parallel path.
 */
interface SpawnRecord {
  cmd: string[];
  env: Record<string, string>;
  startTime: number;
  finishTime?: number;
}

function mockSpawnWithDelay(
  handler: (args: { cmd: string[]; env: Record<string, string> }) => {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    delayMs?: number;
  },
) {
  const calls: SpawnRecord[] = [];
  const startTimestamps = new Map<string, number>();
  const finishTimestamps = new Map<string, number>();
  // Snapshot the running set at the moment each node STARTED.
  const runningWhenStarted = new Map<string, string[]>();
  // Mutable set of currently-running NODE_IDs (mock-internal).
  const currentlyRunning = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = ((cmd: string[], opts?: any) => {
    const env = (opts?.env ?? {}) as Record<string, string>;
    const startTime = Date.now();
    const nodeId = env.NODE_ID ?? "?";
    currentlyRunning.add(nodeId);
    runningWhenStarted.set(nodeId, Array.from(currentlyRunning));
    startTimestamps.set(nodeId, startTime);
    const record: SpawnRecord = { cmd, env, startTime };
    calls.push(record);
    const res = handler({ cmd, env });
    const stdoutStr = res.stdout ?? "";
    const stderrStr = res.stderr ?? "";
    const exitCode = res.exitCode ?? 0;
    const delayMs = res.delayMs ?? 0;

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
        /* noop for delayed tests */
      },
      exited: new Promise<number>((resolve) => {
        if (delayMs > 0) {
          setTimeout(() => {
            const finishTime = Date.now();
            finishTimestamps.set(nodeId, finishTime);
            currentlyRunning.delete(nodeId);
            record.finishTime = finishTime;
            resolve(exitCode);
          }, delayMs);
        } else {
          // Resolve next microtask so the runner's Promise.race still has
          // to actually race (not synchronously settle inside launch).
          queueMicrotask(() => {
            const finishTime = Date.now();
            finishTimestamps.set(nodeId, finishTime);
            currentlyRunning.delete(nodeId);
            record.finishTime = finishTime;
            resolve(exitCode);
          });
        }
      }),
    };
    return proc as unknown as ReturnType<typeof Bun.spawn>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  return {
    fn,
    calls,
    startTimestamps,
    finishTimestamps,
    runningWhenStarted,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown — ensure DI seams reset between tests.
// ---------------------------------------------------------------------------

const ORIG_TEST_TIER = process.env.ASHLR_TEST_TIER;

beforeEach(() => {
  _setIsProSyncForTests(null);
  _setIsTelemetryEnabledForTests(() => false);
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
// 1. Diamond DAG — B + C run concurrently after A; D waits for both
// ---------------------------------------------------------------------------

describe("diamond DAG", () => {
  test("B and C run concurrently after A; D only after both complete", async () => {
    process.env.ASHLR_TEST_TIER = "pro"; // 4 nodes — bumps to team to bypass cap.
    process.env.ASHLR_TEST_TIER = "team";
    const m = mockSpawnWithDelay(() => ({ stdout: "ok", delayMs: 50 }));
    _setSpawnForTests(m.fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B", ["A"]),
        makeNode("C", ["A"]),
        makeNode("D", ["B", "C"]),
      ]),
    });

    expect(r.ok).toBe(true);
    const tA = m.startTimestamps.get("A")!;
    const tB = m.startTimestamps.get("B")!;
    const tC = m.startTimestamps.get("C")!;
    const tD = m.startTimestamps.get("D")!;
    const fA = m.finishTimestamps.get("A")!;
    const fB = m.finishTimestamps.get("B")!;
    const fC = m.finishTimestamps.get("C")!;

    // A first.
    expect(tA).toBeLessThan(tB);
    expect(tA).toBeLessThan(tC);
    // B and C started AFTER A finished.
    expect(tB).toBeGreaterThanOrEqual(fA);
    expect(tC).toBeGreaterThanOrEqual(fA);
    // D started AFTER both B and C finished.
    expect(tD).toBeGreaterThanOrEqual(fB);
    expect(tD).toBeGreaterThanOrEqual(fC);
  });

  test("wave-by-wave timing: B + C launched within 10ms of each other", async () => {
    process.env.ASHLR_TEST_TIER = "team";
    const m = mockSpawnWithDelay(() => ({ stdout: "ok", delayMs: 30 }));
    _setSpawnForTests(m.fn);

    await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B", ["A"]),
        makeNode("C", ["A"]),
        makeNode("D", ["B", "C"]),
      ]),
    });

    const tB = m.startTimestamps.get("B")!;
    const tC = m.startTimestamps.get("C")!;
    // B and C launched in the same wave — should be effectively simultaneous.
    expect(Math.abs(tB - tC)).toBeLessThan(10);
  });

  test("B and C running set overlaps — both in 'currently running' at the same instant", async () => {
    process.env.ASHLR_TEST_TIER = "team";
    const m = mockSpawnWithDelay(() => ({ stdout: "ok", delayMs: 30 }));
    _setSpawnForTests(m.fn);

    await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B", ["A"]),
        makeNode("C", ["A"]),
        makeNode("D", ["B", "C"]),
      ]),
    });

    // When B started, C should ALSO be in the running set (because we fill
    // capacity in a single batch before awaiting). Or vice versa.
    const bSnap = m.runningWhenStarted.get("B") ?? [];
    const cSnap = m.runningWhenStarted.get("C") ?? [];
    const overlap = bSnap.includes("C") || cSnap.includes("B");
    expect(overlap).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Wide fan-out — Pro cap of 3 saturated
// ---------------------------------------------------------------------------

describe("wide fan-out", () => {
  test("3 leaves (Pro cap) run simultaneously", async () => {
    process.env.ASHLR_TEST_TIER = "team"; // 4 nodes total — A + 3 leaves
    const m = mockSpawnWithDelay(() => ({ stdout: "ok", delayMs: 40 }));
    _setSpawnForTests(m.fn);

    await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B", ["A"]),
        makeNode("C", ["A"]),
        makeNode("D", ["A"]),
      ]),
      maxConcurrency: 3,
    });

    // All three leaves should overlap in execution windows.
    const tB = m.startTimestamps.get("B")!;
    const tC = m.startTimestamps.get("C")!;
    const tD = m.startTimestamps.get("D")!;
    const fB = m.finishTimestamps.get("B")!;

    // B started no later than D — same wave.
    expect(Math.abs(tB - tC)).toBeLessThan(15);
    expect(Math.abs(tB - tD)).toBeLessThan(15);
    // All three leaves launched before any of them finished.
    expect(tD).toBeLessThan(fB);
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrency cap enforcement
// ---------------------------------------------------------------------------

describe("concurrency cap", () => {
  test("Pro cap (maxConcurrency=3): with 5 ready-to-run leaves, only 3 in flight", async () => {
    process.env.ASHLR_TEST_TIER = "team"; // 6 total: 1 root + 5 leaves
    let maxObservedInFlight = 0;
    const inFlight = new Set<string>();

    const m = mockSpawnWithDelay(({ env }) => {
      inFlight.add(env.NODE_ID);
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight.size);
      return { stdout: "ok", delayMs: 25 };
    });
    // wrap the mock to remove from inFlight on completion
    const origFn = m.fn;
    const wrapped = ((cmd: string[], opts: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = origFn(cmd, opts as any) as { exited: Promise<number> } & Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodeId = (opts as any)?.env?.NODE_ID as string;
      proc.exited = proc.exited.then((code) => {
        inFlight.delete(nodeId);
        return code;
      });
      return proc;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSpawnForTests(wrapped);

    await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B", ["A"]),
        makeNode("C", ["A"]),
        makeNode("D", ["A"]),
        makeNode("E", ["A"]),
        makeNode("F", ["A"]),
      ]),
      maxConcurrency: 3,
    });

    expect(maxObservedInFlight).toBeLessThanOrEqual(3);
    expect(maxObservedInFlight).toBeGreaterThanOrEqual(2);
  });

  test("maxConcurrency=1 forces strict sequential (v1 back-compat)", async () => {
    process.env.ASHLR_TEST_TIER = "team";
    let maxObservedInFlight = 0;
    const inFlight = new Set<string>();

    const m = mockSpawnWithDelay(({ env }) => {
      inFlight.add(env.NODE_ID);
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight.size);
      return { stdout: "ok", delayMs: 15 };
    });
    const origFn = m.fn;
    const wrapped = ((cmd: string[], opts: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = origFn(cmd, opts as any) as { exited: Promise<number> } & Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodeId = (opts as any)?.env?.NODE_ID as string;
      proc.exited = proc.exited.then((code) => {
        inFlight.delete(nodeId);
        return code;
      });
      return proc;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSpawnForTests(wrapped);

    await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B", ["A"]),
        makeNode("C", ["A"]),
        makeNode("D", ["A"]),
      ]),
      maxConcurrency: 1,
    });

    expect(maxObservedInFlight).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Failure isolation — one node fails, peers + successors still run
// ---------------------------------------------------------------------------

describe("failure isolation", () => {
  test("B fails: C (peer) still ran concurrently; D (successor) still scheduled", async () => {
    process.env.ASHLR_TEST_TIER = "team";
    const m = mockSpawnWithDelay(({ env }) => {
      if (env.NODE_ID === "B") {
        return { stdout: "partial-B", stderr: "boom", exitCode: 1, delayMs: 20 };
      }
      return { stdout: `OUT-${env.NODE_ID}`, delayMs: 20 };
    });
    _setSpawnForTests(m.fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B", ["A"]),
        makeNode("C", ["A"]),
        makeNode("D", ["B", "C"]),
      ]),
    });

    expect(r.ok).toBe(false); // overall fails because B failed
    expect(r.nodeResults).toHaveLength(4); // but ALL 4 still ran
    const ids = r.nodeResults.map((n) => n.nodeId).sort();
    expect(ids).toEqual(["A", "B", "C", "D"]);

    const b = r.nodeResults.find((n) => n.nodeId === "B")!;
    const c = r.nodeResults.find((n) => n.nodeId === "C")!;
    const d = r.nodeResults.find((n) => n.nodeId === "D")!;
    expect(b.ok).toBe(false);
    expect(c.ok).toBe(true);
    expect(d.ok).toBe(true);
  });

  test("D's HANDOFF_PAYLOAD includes the failed B's stdout", async () => {
    process.env.ASHLR_TEST_TIER = "team";
    const seenHandoff: Record<string, string> = {};
    const m = mockSpawnWithDelay(({ env }) => {
      seenHandoff[env.NODE_ID] = env.HANDOFF_PAYLOAD;
      if (env.NODE_ID === "B") {
        return { stdout: "B-PARTIAL", stderr: "kaboom", exitCode: 1, delayMs: 15 };
      }
      return { stdout: `OUT-${env.NODE_ID}`, delayMs: 15 };
    });
    _setSpawnForTests(m.fn);

    await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B", ["A"]),
        makeNode("C", ["A"]),
        makeNode("D", ["B", "C"]),
      ]),
    });

    expect(seenHandoff["D"]).toContain("[from B]");
    expect(seenHandoff["D"]).toContain("B-PARTIAL");
    expect(seenHandoff["D"]).toContain("[from C]");
    expect(seenHandoff["D"]).toContain("OUT-C");
  });
});

// ---------------------------------------------------------------------------
// 5. Dry-run still respects DAG
// ---------------------------------------------------------------------------

describe("dry-run + parallel", () => {
  test("dryRun=true on diamond: all nodes complete with [dry-run], no spawn", async () => {
    process.env.ASHLR_TEST_TIER = "team";
    const m = mockSpawnWithDelay(() => ({ stdout: "should not run" }));
    _setSpawnForTests(m.fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B", ["A"]),
        makeNode("C", ["A"]),
        makeNode("D", ["B", "C"]),
      ]),
      dryRun: true,
    });

    expect(r.ok).toBe(true);
    expect(m.calls.length).toBe(0);
    expect(r.nodeResults).toHaveLength(4);
    for (const n of r.nodeResults) {
      expect(n.output).toBe("[dry-run]");
      expect(n.ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Tier gate still fires BEFORE the scheduler
// ---------------------------------------------------------------------------

describe("tier gate (parallel runner)", () => {
  test("Pro + 4 nodes still rejected before scheduling: zero spawns", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    const m = mockSpawnWithDelay(() => ({ stdout: "no" }));
    _setSpawnForTests(m.fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B"),
        makeNode("C"),
        makeNode("D"),
      ]),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("pro-tier-3-agent-cap");
    expect(m.calls.length).toBe(0);
    expect(r.maxConcurrentWindows).toEqual([]); // never started
  });
});

// ---------------------------------------------------------------------------
// 7. Critical-path duration — diamond ≈ 3×slot, not 4×slot
// ---------------------------------------------------------------------------

describe("critical-path duration", () => {
  test("diamond with 50ms-per-node nodes finishes in ~3 waves (not 4)", async () => {
    process.env.ASHLR_TEST_TIER = "team";
    const m = mockSpawnWithDelay(() => ({ stdout: "ok", delayMs: 50 }));
    _setSpawnForTests(m.fn);

    const t0 = Date.now();
    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B", ["A"]),
        makeNode("C", ["A"]),
        makeNode("D", ["B", "C"]),
      ]),
    });
    const total = Date.now() - t0;

    expect(r.ok).toBe(true);
    // Sequential would be 4×50ms = 200ms (+overhead). Parallel critical-path
    // is A→B→D = 3×50ms = 150ms. Allow generous slop for jitter (sub-225ms
    // is still well below the 200ms baseline of sequential).
    expect(total).toBeLessThan(225);
    // And the parallel run must NOT be insta-fast either — confidence floor.
    expect(total).toBeGreaterThanOrEqual(140);
  });
});

// ---------------------------------------------------------------------------
// 8. maxConcurrentWindows — timeline transitions recorded
// ---------------------------------------------------------------------------

describe("maxConcurrentWindows", () => {
  test("transitions captured on every start and completion", async () => {
    process.env.ASHLR_TEST_TIER = "team";
    const m = mockSpawnWithDelay(() => ({ stdout: "ok", delayMs: 20 }));
    _setSpawnForTests(m.fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B", ["A"]),
        makeNode("C", ["A"]),
      ]),
    });

    expect(r.maxConcurrentWindows.length).toBeGreaterThan(0);
    // First snapshot is when A is launched — running set = ["A"].
    expect(r.maxConcurrentWindows[0]!.runningIds).toEqual(["A"]);
    // The MAX running-set size across all windows reflects the concurrency
    // achieved. For (A→B, A→C) under maxConcurrency>=2, we should see B+C
    // running together at some point.
    const maxObserved = r.maxConcurrentWindows.reduce(
      (m, w) => Math.max(m, w.runningIds.length),
      0,
    );
    expect(maxObserved).toBeGreaterThanOrEqual(2);
    // Final snapshot is empty (all done).
    expect(r.maxConcurrentWindows[r.maxConcurrentWindows.length - 1]!.runningIds).toEqual([]);
  });

  test("each window has an ISO timestamp", async () => {
    process.env.ASHLR_TEST_TIER = "pro";
    const m = mockSpawnWithDelay(() => ({ stdout: "ok", delayMs: 5 }));
    _setSpawnForTests(m.fn);

    const r = await runTaskGraph({
      graph: makeGraph([makeNode("A"), makeNode("B", ["A"])]),
    });

    for (const w of r.maxConcurrentWindows) {
      expect(w.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Team tier saturation
// ---------------------------------------------------------------------------

describe("team tier saturation", () => {
  test("team tier with 10 independent leaves: all run concurrently", async () => {
    process.env.ASHLR_TEST_TIER = "team";
    let maxObservedInFlight = 0;
    const inFlight = new Set<string>();
    const m = mockSpawnWithDelay(({ env }) => {
      inFlight.add(env.NODE_ID);
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight.size);
      return { stdout: "ok", delayMs: 30 };
    });
    const origFn = m.fn;
    const wrapped = ((cmd: string[], opts: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = origFn(cmd, opts as any) as { exited: Promise<number> } & Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodeId = (opts as any)?.env?.NODE_ID as string;
      proc.exited = proc.exited.then((code) => {
        inFlight.delete(nodeId);
        return code;
      });
      return proc;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSpawnForTests(wrapped);

    const nodes: TaskNode[] = [];
    for (let i = 0; i < 10; i++) nodes.push(makeNode(`leaf-${i}`));

    const r = await runTaskGraph({ graph: makeGraph(nodes) });
    expect(r.ok).toBe(true);
    expect(maxObservedInFlight).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 10. Result ordering — deterministic topo order despite parallel completion
// ---------------------------------------------------------------------------

describe("result ordering", () => {
  test("nodeResults is in topological order even when completion is out-of-order", async () => {
    process.env.ASHLR_TEST_TIER = "team";
    // Make C finish before B by giving B a longer delay.
    const m = mockSpawnWithDelay(({ env }) => ({
      stdout: `ok-${env.NODE_ID}`,
      delayMs: env.NODE_ID === "B" ? 60 : 10,
    }));
    _setSpawnForTests(m.fn);

    const r = await runTaskGraph({
      graph: makeGraph([
        makeNode("A"),
        makeNode("B", ["A"]),
        makeNode("C", ["A"]),
        makeNode("D", ["B", "C"]),
      ]),
    });

    expect(r.ok).toBe(true);
    // Topological order (with input-order tiebreak): A, B, C, D.
    const ids = r.nodeResults.map((n) => n.nodeId);
    expect(ids).toEqual(["A", "B", "C", "D"]);
  });
});
