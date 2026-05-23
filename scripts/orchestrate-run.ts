/**
 * orchestrate-run.ts — Track B sequential runner for the orchestration DAG.
 *
 * Walks the TaskGraph in dependency order, spawning a per-node Bun subprocess
 * (stub for the MVP — real Claude orchestration ships in wk 4-6), propagating
 * handoff payloads downstream, and emitting per-node telemetry when consent
 * is on.
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
 * use either name.
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
  /** Optional reason when the run was rejected at the tier gate. */
  error?: string;
}

export interface RunOptions {
  graph: TaskGraph;
  dryRun?: boolean;
  onNodeStart?: (node: TaskNode) => void;
  onNodeComplete?: (node: TaskNode, result: NodeResult) => void;
  cwd?: string;
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

// ---------------------------------------------------------------------------
// Topological sort — same algorithm as the renderer; duplicated here so the
// runner doesn't import the renderer (separation of concerns).
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
 * canned message via `bun --eval`; the real implementation in wk 4-6 will
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

  // -- Execution ------------------------------------------------------------
  const ordered = topoSort(g.nodes);
  const results: NodeResult[] = [];
  const resultById = new Map<string, NodeResult>();

  for (const node of ordered) {
    opts.onNodeStart?.(node);
    emitTelemetry("orchestrate_node_start", {
      node_id_hash: hashShort(node.id),
      agent_kind: node.agentKind,
    });

    // Build handoff payload: concatenated stdout of all completed predecessors,
    // separated by node-id headers so receivers can disambiguate.
    const handoff = (node.deps ?? [])
      .map((dep) => resultById.get(dep))
      .filter((r): r is NodeResult => !!r)
      .map((r) => `[from ${r.id}]\n${r.output ?? ""}`)
      .join("\n---\n");

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

    results.push(nodeResult);
    resultById.set(node.id, nodeResult);
    opts.onNodeComplete?.(node, nodeResult);
    emitTelemetry("orchestrate_node_complete", {
      node_id_hash: hashShort(node.id),
      ok: nodeResult.ok,
      duration_ms: nodeResult.durationMs,
    });
  }

  const finishedAt = new Date().toISOString();
  const totalDurationMs = Date.now() - t0;
  const totalTokens = results.reduce((s, r) => s + (r.tokens ?? 0), 0);
  const ok = results.every((r) => r.ok);

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
