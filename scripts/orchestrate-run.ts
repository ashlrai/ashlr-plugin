/**
 * orchestrate-run.ts — Track B runner for the orchestration DAG.
 *
 * Walks the TaskGraph in dependency order, spawning a per-node Bun subprocess
 * (stub for the MVP — real Claude orchestration ships in wk 7+), propagating
 * handoff payloads downstream, and emitting per-node telemetry when consent
 * is on.
 *
 * v1 (sequential): nodes ran one-at-a-time in topological order.
 * v2 (Q1'27 wk 4-6, this file): PARALLEL-where-deps-allow scheduling.
 *   - Pro tier:  maxConcurrency=3 (matches the 3-agent cap).
 *   - Team tier: maxConcurrency=10 (matches the 10-agent cap).
 *   - Override via RunOptions.maxConcurrency for tests.
 *   - maxConcurrency=1 produces sequential behavior identical to v1 (used by
 *     the existing __tests__/orchestrate-run.test.ts).
 *
 * Tier gates (top of run, BEFORE any subprocess):
 *   - free                       → ok=false  error="free-tier"
 *   - pro,   nodes.length >  3   → ok=false  error="pro-tier-3-agent-cap"
 *   - team,  nodes.length > 10   → ok=false  error="team-tier-10-agent-cap"
 *
 * Tier resolution honors ASHLR_TEST_TIER ("free"|"pro"|"team") for tests; in
 * production it falls back to isProSync. DI seams (_setIsProSyncForTests +
 * _setIsTelemetryEnabledForTests) follow the v1.30 _setDailyHeartbeatFetch
 * pattern in servers/_telemetry.ts.
 *
 * Shape compatibility: the existing Track C CLI (scripts/cli-orchestrate.ts)
 * consumes RunResult fields `ok`, `totalDurationMs`, `totalTokens`, `nodes`,
 * where each node carries `id/ok/durationMs/tokens/error`. We KEEP those for
 * back-compat AND add the spec-required aliases (graphId, startedAt,
 * finishedAt, nodeResults, totalTokensUsed, nodeId) so external callers can
 * use either name. v2 adds `maxConcurrentWindows` — a timeline of running-set
 * transitions for observability tools.
 */

import { isProSync } from "../servers/_pro.ts";
import { isTelemetryEnabled, recordTelemetryEvent } from "../servers/_telemetry.ts";
import type { TaskGraph, TaskNode } from "../servers/_task-graph.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NodeResult {
  /** Legacy field name kept for Track C cli-orchestrate compatibility. */
  id: string;
  /** Spec-required alias of `id`. */
  nodeId: string;
  ok: boolean;
  durationMs: number;
  /** Legacy field name. */
  tokens: number;
  /** Spec-required alias of `tokens`. */
  tokensUsed: number;
  output?: string;
  error?: string;
}

/**
 * Snapshot of which nodes were running at a given instant. Recorded only on
 * transitions (a node starts or completes); lets observability tools
 * reconstruct the parallel-execution timeline without polling.
 */
export interface ConcurrencyWindow {
  /** ISO timestamp of the transition. */
  time: string;
  /** Node IDs currently running at that instant. */
  runningIds: string[];
}

export interface RunResult {
  ok: boolean;
  /** Stable ID of the source graph. */
  graphId: string;
  startedAt: string;
  finishedAt: string;
  /** Legacy total duration field kept for cli-orchestrate. */
  totalDurationMs: number;
  /** Legacy total token field kept for cli-orchestrate. */
  totalTokens: number;
  /** Spec-required alias of totalTokens. */
  totalTokensUsed: number;
  /** Legacy per-node list — cli-orchestrate iterates this. */
  nodes: NodeResult[];
  /** Spec-required alias of nodes. */
  nodeResults: NodeResult[];
  /**
   * Timeline of running-set transitions. Each entry is captured when the
   * running set changes (a node starts OR completes). Empty when no nodes
   * ever ran (e.g., tier-rejected runs).
   */
  maxConcurrentWindows: ConcurrencyWindow[];
  /** Optional reason when the run was rejected at the tier gate. */
  error?: string;
}

export interface RunOptions {
  graph: TaskGraph;
  dryRun?: boolean;
  onNodeStart?: (node: TaskNode) => void;
  onNodeComplete?: (node: TaskNode, result: NodeResult) => void;
  cwd?: string;
  /**
   * Override the per-run concurrency cap. Defaults to the tier cap
   * (Pro=3, Team=10). Tests use this to assert wave-by-wave timing.
   * Must be >= 1.
   */
  maxConcurrency?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRO_NODE_CAP = 3;
const TEAM_NODE_CAP = 10;
const NODE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// DI seams — tests swap these via _setIsProSyncForTests / _setIsTelemetry...
// ---------------------------------------------------------------------------

type IsProFn = () => boolean;
type IsTelemetryFn = () => boolean;
type SpawnFn = typeof Bun.spawn;

let _isProImpl: IsProFn | null = null;
let _isTelemetryImpl: IsTelemetryFn | null = null;
let _spawnImpl: SpawnFn | null = null;

/** Test seam: override the pro-tier check. Pass null to restore default. */
export function _setIsProSyncForTests(fn: IsProFn | null): void {
  _isProImpl = fn;
}

/** Test seam: override the telemetry-enabled check. Pass null to restore. */
export function _setIsTelemetryEnabledForTests(fn: IsTelemetryFn | null): void {
  _isTelemetryImpl = fn;
}

/** Test seam: override Bun.spawn. Pass null to restore. */
export function _setSpawnForTests(fn: SpawnFn | null): void {
  _spawnImpl = fn;
}

function isProGuarded(): boolean {
  return _isProImpl ? _isProImpl() : isProSync();
}

function isTelemetryGuarded(): boolean {
  return _isTelemetryImpl ? _isTelemetryImpl() : isTelemetryEnabled();
}

function spawnGuarded(...args: Parameters<SpawnFn>): ReturnType<SpawnFn> {
  return (_spawnImpl ?? Bun.spawn)(...args);
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

export type Tier = "free" | "pro" | "team";

function resolveTierForRun(env: NodeJS.ProcessEnv = process.env): Tier {
  const override = env["ASHLR_TEST_TIER"];
  if (override === "free" || override === "pro" || override === "team") return override;
  return isProGuarded() ? "pro" : "free";
}

function tierDefaultConcurrency(tier: Tier): number {
  if (tier === "team") return TEAM_NODE_CAP;
  if (tier === "pro") return PRO_NODE_CAP;
  return 1; // free tier never reaches the scheduler, but be defensive.
}

// ---------------------------------------------------------------------------
// Topological sort — used as a TIEBREAKER for ready nodes so the runner has
// stable, deterministic ordering between otherwise-parallel-eligible peers.
// Duplicated here so the runner doesn't import the renderer (separation of
// concerns).
// ---------------------------------------------------------------------------

function topoSort(nodes: readonly TaskNode[]): TaskNode[] {
  const byId = new Map<string, TaskNode>();
  const indegree = new Map<string, number>();
  const inputOrder = new Map<string, number>();
  nodes.forEach((n, i) => {
    byId.set(n.id, n);
    inputOrder.set(n.id, i);
  });
  const successors = new Map<string, string[]>();
  for (const n of nodes) {
    const deps = (Array.isArray(n.deps) ? n.deps : []).filter((d) => byId.has(d));
    indegree.set(n.id, deps.length);
    for (const d of deps) {
      const list = successors.get(d) ?? [];
      list.push(n.id);
      successors.set(d, list);
    }
  }
  const ready: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) ready.push(id);
  ready.sort((a, b) => (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0));

  const out: TaskNode[] = [];
  const visited = new Set<string>();
  while (ready.length > 0) {
    const id = ready.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const n = byId.get(id);
    if (n) out.push(n);
    for (const s of successors.get(id) ?? []) {
      const next = (indegree.get(s) ?? 0) - 1;
      indegree.set(s, next);
      if (next === 0 && !visited.has(s)) ready.push(s);
    }
    ready.sort((a, b) => (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0));
  }
  if (out.length < nodes.length) {
    for (const n of nodes) if (!visited.has(n.id)) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function tierRejectResult(graphId: string, reason: string): RunResult {
  const now = new Date().toISOString();
  return {
    ok: false,
    graphId,
    startedAt: now,
    finishedAt: now,
    totalDurationMs: 0,
    totalTokens: 0,
    totalTokensUsed: 0,
    nodes: [],
    nodeResults: [],
    maxConcurrentWindows: [],
    error: reason,
  };
}

function makeNodeResult(
  node: TaskNode,
  partial: { ok: boolean; durationMs: number; tokens: number; output?: string; error?: string },
): NodeResult {
  return {
    id: node.id,
    nodeId: node.id,
    ok: partial.ok,
    durationMs: partial.durationMs,
    tokens: partial.tokens,
    tokensUsed: partial.tokens,
    output: partial.output,
    error: partial.error,
  };
}

// ---------------------------------------------------------------------------
// Subprocess execution
// ---------------------------------------------------------------------------

interface SpawnEnv {
  NODE_ID: string;
  NODE_GOAL: string;
  NODE_SCOPE: string;
  HANDOFF_PAYLOAD: string;
}

/**
 * Execute a single node as a Bun subprocess. The MVP stub just echoes a
 * canned message via `bun --eval`; the real implementation in wk 7+ will
 * spawn a Claude Code subagent.
 *
 * Returns the node result. Per-node failures are recorded but never thrown —
 * the caller continues running subsequent nodes.
 */
async function executeNode(
  node: TaskNode,
  env: SpawnEnv,
  cwd: string | undefined,
): Promise<{ ok: boolean; output: string; error?: string; durationMs: number }> {
  const t0 = Date.now();
  try {
    const proc = spawnGuarded(
      [
        "bun",
        "--eval",
        "console.log('STUB-NODE: ' + (process.env.NODE_ID || 'unknown'));",
      ],
      {
        env: { ...process.env, ...env },
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    // 30s wallclock per-node timeout.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* best-effort */
      }
    }, NODE_TIMEOUT_MS);

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
    }

    const durationMs = Date.now() - t0;

    if (timedOut) {
      return {
        ok: false,
        output: stdout,
        error: `timeout after ${NODE_TIMEOUT_MS}ms`,
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
// Public entry — runTaskGraph
// ---------------------------------------------------------------------------

export async function runTaskGraph(opts: RunOptions): Promise<RunResult> {
  const g = opts.graph;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // -- Tier gate ------------------------------------------------------------
  const tier = resolveTierForRun();
  if (tier === "free") {
    return tierRejectResult(g.id, "free-tier");
  }
  if (tier === "pro" && g.nodes.length > PRO_NODE_CAP) {
    return tierRejectResult(g.id, "pro-tier-3-agent-cap");
  }
  if (tier === "team" && g.nodes.length > TEAM_NODE_CAP) {
    return tierRejectResult(g.id, "team-tier-10-agent-cap");
  }

  // -- Concurrency selection -------------------------------------------------
  // The override clamps to >=1. Default mirrors the tier's agent cap so the
  // scheduler can saturate every slot the tier paid for.
  const maxConcurrency = Math.max(
    1,
    Math.floor(opts.maxConcurrency ?? tierDefaultConcurrency(tier)),
  );

  // -- Scheduler state -------------------------------------------------------
  // `topoOrder` is the tiebreaker for picking among multiple ready nodes —
  // gives stable, deterministic output between parallel-eligible peers.
  const topoOrder = topoSort(g.nodes);
  const topoIndex = new Map<string, number>();
  topoOrder.forEach((n, i) => topoIndex.set(n.id, i));
  const byId = new Map(g.nodes.map((n) => [n.id, n] as const));

  const results: NodeResult[] = [];
  const resultById = new Map<string, NodeResult>();
  const completed = new Set<string>();
  const running = new Map<string, Promise<{ id: string; node: TaskNode; result: NodeResult }>>();
  const remaining = new Set<string>(g.nodes.map((n) => n.id));
  const windows: ConcurrencyWindow[] = [];

  const snapshotWindow = (): void => {
    windows.push({
      time: new Date().toISOString(),
      runningIds: Array.from(running.keys()),
    });
  };

  const launch = (node: TaskNode): void => {
    opts.onNodeStart?.(node);
    emitTelemetry("orchestrate_node_start", {
      node_id_hash: hashShort(node.id),
      agent_kind: node.agentKind,
    });

    // Handoff payload: concatenated stdout of all completed predecessors,
    // separated by node-id headers so receivers can disambiguate. Because we
    // only launch nodes whose deps are ALL in `completed`, this is guaranteed
    // to include every predecessor's terminal output (success OR failure).
    const handoff = (node.deps ?? [])
      .map((dep) => resultById.get(dep))
      .filter((r): r is NodeResult => !!r)
      .map((r) => `[from ${r.id}]\n${r.output ?? ""}`)
      .join("\n---\n");

    const promise = (async () => {
      let nodeResult: NodeResult;
      if (opts.dryRun) {
        nodeResult = makeNodeResult(node, {
          ok: true,
          durationMs: 0,
          tokens: node.estimatedTokens ?? 0,
          output: "[dry-run]",
        });
      } else {
        const exec = await executeNode(
          node,
          {
            NODE_ID: node.id,
            NODE_GOAL: node.goal,
            NODE_SCOPE: (node.scope ?? []).join(":"),
            HANDOFF_PAYLOAD: handoff,
          },
          opts.cwd,
        );
        nodeResult = makeNodeResult(node, {
          ok: exec.ok,
          durationMs: exec.durationMs,
          tokens: exec.ok ? (node.estimatedTokens ?? 0) : 0,
          output: exec.output,
          error: exec.error,
        });
      }
      return { id: node.id, node, result: nodeResult };
    })();

    running.set(node.id, promise);
    snapshotWindow(); // transition: a node just started.
  };

  // -- Main scheduler loop --------------------------------------------------
  // Invariants:
  //   - A node is in exactly one of {remaining, running, completed}.
  //   - We only `launch` a node whose every dep is in `completed`.
  //   - Each iteration starts as many ready nodes as `maxConcurrency` allows,
  //     then awaits the first one to finish (Promise.race). On finish, we
  //     record + drain, then loop.
  while (remaining.size > 0 || running.size > 0) {
    // Fill capacity with every ready-and-not-running node, preferring topo
    // order for stable output among equivalents.
    while (running.size < maxConcurrency) {
      const ready: TaskNode[] = [];
      for (const id of remaining) {
        const n = byId.get(id);
        if (!n) continue;
        const depsDone = (n.deps ?? []).every((d) => completed.has(d) || !byId.has(d));
        if (depsDone) ready.push(n);
      }
      if (ready.length === 0) break;
      ready.sort((a, b) => (topoIndex.get(a.id) ?? 0) - (topoIndex.get(b.id) ?? 0));
      const next = ready[0]!;
      remaining.delete(next.id);
      launch(next);
    }

    if (running.size === 0) {
      // Defensive: nothing ready, nothing running — would deadlock. Break to
      // exit cleanly; remaining nodes will be left unrun and `ok` will be
      // false because any unmet deps mean the graph was malformed.
      break;
    }

    // Wait for the FIRST running node to finish, then record + emit hooks.
    const done = await Promise.race(running.values());
    running.delete(done.id);
    completed.add(done.id);
    results.push(done.result);
    resultById.set(done.id, done.result);

    opts.onNodeComplete?.(done.node, done.result);
    emitTelemetry("orchestrate_node_complete", {
      node_id_hash: hashShort(done.id),
      ok: done.result.ok,
      duration_ms: done.result.durationMs,
    });
    snapshotWindow(); // transition: a node just completed.
  }

  // -- Stable result ordering ----------------------------------------------
  // `results` is in COMPLETION order (which depends on subprocess timing).
  // Re-sort by topological order so external consumers see deterministic
  // output regardless of scheduling jitter. cli-orchestrate iterates this.
  results.sort((a, b) => (topoIndex.get(a.id) ?? 0) - (topoIndex.get(b.id) ?? 0));

  const finishedAt = new Date().toISOString();
  const totalDurationMs = Date.now() - t0;
  const totalTokens = results.reduce((s, r) => s + (r.tokens ?? 0), 0);
  const ok = results.length === g.nodes.length && results.every((r) => r.ok);

  return {
    ok,
    graphId: g.id,
    startedAt,
    finishedAt,
    totalDurationMs,
    totalTokens,
    totalTokensUsed: totalTokens,
    nodes: results,
    nodeResults: results,
    maxConcurrentWindows: windows,
  };
}

// ---------------------------------------------------------------------------
// Telemetry — only emits when consent is on. We piggy-back on the generic
// recordTelemetryEvent so the buffer + privacy guards are inherited.
// ---------------------------------------------------------------------------

function emitTelemetry(kind: string, fields: Record<string, unknown>): void {
  try {
    if (!isTelemetryGuarded()) return;
    // We use the `wizard_step` typed kind only to satisfy the type-checker —
    // the underlying recordTelemetryEvent only cares about `kind` + spread.
    // The server tolerates unknown kinds (rolls them up under "other").
    recordTelemetryEvent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kind: kind as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(fields as any),
    } as never);
  } catch {
    /* never propagate */
  }
}

function hashShort(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
