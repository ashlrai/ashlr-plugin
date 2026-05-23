/**
 * orchestrate-run.ts — Track B scaffold for the sequential runner.
 *
 * Walks the TaskGraph in dependency order (using `deps`, not dependsOn,
 * to match the Track A schema), executing each node. The full Track B
 * impl spawns Claude Code subagents; this scaffold simulates each node
 * and emits a RunResult shape the CLI summary + tests can consume.
 *
 * Honors `dryRun: true` by skipping any real work and stamping ok=true
 * for every node — the integration smoke test exercises this path.
 */

import type { TaskGraph, TaskNode } from "../servers/_task-graph.ts";

export interface NodeResult {
  id: string;
  ok: boolean;
  durationMs: number;
  tokens: number;
  error?: string;
}

export interface RunResult {
  ok: boolean;
  totalDurationMs: number;
  totalTokens: number;
  nodes: NodeResult[];
}

export interface RunOptions {
  graph: TaskGraph;
  dryRun?: boolean;
  cwd?: string;
}

/** Topological sort using the Track A `deps` field. */
function topoSort(nodes: TaskNode[]): TaskNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const visited = new Set<string>();
  const out: TaskNode[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const n = byId.get(id);
    if (!n) return;
    for (const dep of n.deps ?? []) visit(dep);
    out.push(n);
  };
  for (const n of nodes) visit(n.id);
  return out;
}

export async function runTaskGraph(opts: RunOptions): Promise<RunResult> {
  const start = Date.now();
  const ordered = topoSort(opts.graph.nodes);
  const results: NodeResult[] = [];
  for (const node of ordered) {
    const t0 = Date.now();
    if (opts.dryRun) {
      results.push({
        id: node.id,
        ok: true,
        durationMs: Date.now() - t0,
        tokens: 0,
      });
      continue;
    }
    // Real execution lands in Track B. For now stub a fake success.
    results.push({
      id: node.id,
      ok: true,
      durationMs: Date.now() - t0,
      tokens: node.estimatedTokens ?? 0,
    });
  }
  return {
    ok: results.every((r) => r.ok),
    totalDurationMs: Date.now() - start,
    totalTokens: results.reduce((s, r) => s + r.tokens, 0),
    nodes: results,
  };
}
