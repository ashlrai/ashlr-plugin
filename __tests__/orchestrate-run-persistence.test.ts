/**
 * orchestrate-run-persistence.test.ts — Q1 '27 run-result persistence.
 *
 * Asserts the additive persistence step in scripts/orchestrate-run.ts:
 *   1. runTaskGraph writes ~/.ashlr/orchestrations/<graphId>/result.json
 *      after completion.
 *   2. Best-effort: if the fs.mkdir/write fails, the runner still returns the
 *      result successfully (no throw, ok still reflects the run).
 *   3. Pruning keeps 50 latest run dirs (sorted by mtime DESC).
 *
 * Tests redirect HOME to a tmp dir via _setHomedirForTests so they never
 * touch the real ~/.ashlr/. Pattern mirrors __tests__/cli-orchestrate.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  runTaskGraph,
  _setIsProSyncForTests,
  _setIsTelemetryEnabledForTests,
  _setSpawnForTests,
  _setHomedirForTests,
} from "../scripts/orchestrate-run";
import type { TaskGraph, TaskNode } from "../servers/_task-graph";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome: string;

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

function makeGraph(id: string, nodes: TaskNode[]): TaskGraph {
  const totalTokenBudget = nodes.reduce((s, n) => s + n.estimatedTokens, 0);
  return {
    id,
    goal: `run for ${id}`,
    scope: "/tmp/run",
    tier: "pro",
    createdAt: "2027-01-01T00:00:00.000Z",
    nodes,
    handoffs: [],
    metadata: { autoExpanded: true, totalTokenBudget },
  };
}

/**
 * Mock Bun.spawn that returns canned stdout + an immediate exit.
 * Duck-typed; the runner only reads stdout / stderr / exited / exitCode / kill.
 */
function makeMockSpawn() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = ((_cmd: string[]) => {
    const proc: Record<string, unknown> = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("STUB"));
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
    };
    return proc as unknown as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
  return fn;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ashlr-orch-persist-"));
  _setIsProSyncForTests(() => true);
  _setIsTelemetryEnabledForTests(() => false);
  _setSpawnForTests(makeMockSpawn());
  _setHomedirForTests(() => tmpHome);
});

afterEach(() => {
  _setIsProSyncForTests(null);
  _setIsTelemetryEnabledForTests(null);
  _setSpawnForTests(null);
  _setHomedirForTests(null);
  if (tmpHome && existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. writes result.json after completion
// ---------------------------------------------------------------------------

describe("persistence", () => {
  test("runTaskGraph writes ~/.ashlr/orchestrations/<id>/result.json", async () => {
    const graph = makeGraph("g-persist-1", [makeNode("a"), makeNode("b")]);
    const result = await runTaskGraph({ graph });
    expect(result.ok).toBe(true);

    const file = join(tmpHome, ".ashlr", "orchestrations", "g-persist-1", "result.json");
    expect(existsSync(file)).toBe(true);

    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.graph.id).toBe("g-persist-1");
    expect(parsed.result.ok).toBe(true);
    expect(parsed.result.graphId).toBe("g-persist-1");
    expect(parsed.result.nodes).toHaveLength(2);
  });

  test("dry-run still persists (records that the run happened)", async () => {
    const graph = makeGraph("g-persist-dry", [makeNode("only")]);
    await runTaskGraph({ graph, dryRun: true });
    const file = join(tmpHome, ".ashlr", "orchestrations", "g-persist-dry", "result.json");
    expect(existsSync(file)).toBe(true);
  });

  test("tier-rejected runs are not persisted (early-return short-circuits)", async () => {
    // Free tier rejects before runTaskGraph reaches the persistence step.
    _setIsProSyncForTests(() => false);
    const graph = makeGraph("g-persist-free", [makeNode("a")]);
    const result = await runTaskGraph({ graph });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("free-tier");
    const file = join(tmpHome, ".ashlr", "orchestrations", "g-persist-free", "result.json");
    expect(existsSync(file)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. best-effort: write failure is swallowed
// ---------------------------------------------------------------------------

describe("persistence — best-effort", () => {
  test("write failure does not throw — runner still returns the result", async () => {
    // Redirect HOME to a path that cannot be created (a regular file masquerading
    // as a parent directory). mkdirSync will throw EEXIST/ENOTDIR; the runner
    // must swallow it and return the result anyway.
    const blocker = join(tmpHome, "blocker");
    writeFileSync(blocker, "I am a file, not a directory");
    _setHomedirForTests(() => blocker);

    const graph = makeGraph("g-persist-fail", [makeNode("a")]);
    const result = await runTaskGraph({ graph });
    expect(result.ok).toBe(true);
    expect(result.graphId).toBe("g-persist-fail");
  });
});

// ---------------------------------------------------------------------------
// 3. pruning keeps 50 latest
// ---------------------------------------------------------------------------

describe("persistence — pruning", () => {
  test("writing the 51st run trims the oldest", async () => {
    const orchDir = join(tmpHome, ".ashlr", "orchestrations");
    mkdirSync(orchDir, { recursive: true });

    // Pre-seed 50 dirs with staggered mtimes (oldest first). We touch the
    // directory mtime explicitly so the pruning sort is deterministic.
    for (let i = 0; i < 50; i++) {
      const id = `g-seed-${String(i).padStart(3, "0")}`;
      const d = join(orchDir, id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "result.json"), "{}");
      // mtime = 1_000_000 + i (older = lower).
      const t = 1_000_000 + i;
      utimesSync(d, t, t);
    }
    expect(readdirSync(orchDir)).toHaveLength(50);

    // Now write a 51st via the runner — it should prune the oldest seed.
    const graph = makeGraph("g-prune-new", [makeNode("a")]);
    await runTaskGraph({ graph });

    const remaining = readdirSync(orchDir);
    expect(remaining.length).toBeLessThanOrEqual(50);
    expect(remaining).toContain("g-prune-new");
    expect(remaining).not.toContain("g-seed-000"); // oldest gone
  });

  test("with under 50 runs, nothing is pruned", async () => {
    const graph1 = makeGraph("g-keep-1", [makeNode("a")]);
    const graph2 = makeGraph("g-keep-2", [makeNode("a")]);
    await runTaskGraph({ graph: graph1 });
    await runTaskGraph({ graph: graph2 });
    const orchDir = join(tmpHome, ".ashlr", "orchestrations");
    expect(readdirSync(orchDir).sort()).toEqual(["g-keep-1", "g-keep-2"]);
  });
});
