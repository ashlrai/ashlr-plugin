/**
 * _task-graph-render.ts — Track B rich renderer for the orchestration DAG.
 *
 * Renders a TaskGraph as a numbered topological tree with per-node agent kind,
 * token budget, scope truncation, and dep markers. The slash command + tests
 * assert against the output; the CLI prints it ahead of the y/n/e confirm.
 *
 * Public surface (stable contract with Track C):
 *
 *   renderTaskGraph(g: TaskGraph, opts?: RenderOptions): string
 *
 * Guarantees:
 *   - Never throws. Falls back to a plain-text dump if anything goes sideways.
 *   - Deterministic: stable topo order (input order is a tiebreaker).
 *   - Color OFF by default — keeps test goldens stable.
 *   - Empty graph → "Orchestration plan — empty graph (0 nodes)".
 *   - Single node → no "depends on" markers.
 */

import type { TaskGraph, TaskNode } from "./_task-graph.ts";

export interface RenderOptions {
  /** Enable ANSI color sequences (default: false for deterministic tests). */
  color?: boolean;
  /** Truncate per-node scope listings beyond this many entries (default: 5). */
  maxScopeFiles?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function renderTaskGraph(g: TaskGraph, opts: RenderOptions = {}): string {
  try {
    return doRender(g, opts);
  } catch {
    // Renderer must NEVER throw — fall back to a plain-text dump that callers
    // can still display while we investigate the failure mode.
    return safeFallback(g);
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function doRender(g: TaskGraph, opts: RenderOptions): string {
  const maxScope = Number.isFinite(opts.maxScopeFiles) && (opts.maxScopeFiles as number) >= 0
    ? Math.floor(opts.maxScopeFiles as number)
    : 5;
  const useColor = opts.color === true;

  const bold = (s: string): string => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
  const dim  = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
  const cyan = (s: string): string => (useColor ? `\x1b[36m${s}\x1b[0m` : s);

  const lines: string[] = [];

  // Empty graph — short-circuit before topo sort.
  if (!g.nodes || g.nodes.length === 0) {
    lines.push(bold(`Orchestration plan`) + ` — empty graph (0 nodes)`);
    if (g.goal) lines.push(`  goal: ${quote(g.goal)}`);
    if (g.scope) lines.push(`  scope: ${g.scope}`);
    return lines.join("\n");
  }

  // -- Header -----------------------------------------------------------------
  const nodeCount = g.nodes.length;
  const budget = typeof g.metadata?.totalTokenBudget === "number"
    ? g.metadata.totalTokenBudget
    : g.nodes.reduce((s, n) => s + (Number.isFinite(n.estimatedTokens) ? n.estimatedTokens : 0), 0);

  lines.push(`${bold("Orchestration plan")} — goal: ${quote(g.goal ?? "")}`);
  if (g.scope) lines.push(`scope: ${g.scope}`);
  lines.push(
    `tier: ${g.tier} · ${nodeCount} ${nodeCount === 1 ? "node" : "nodes"} · ~${formatTokens(budget)} token budget`,
  );

  // -- Topological order ------------------------------------------------------
  const ordered = topoSort(g.nodes);
  const positionById = new Map<string, number>();
  ordered.forEach((n, i) => positionById.set(n.id, i + 1));

  for (let i = 0; i < ordered.length; i++) {
    const n = ordered[i]!;
    lines.push(""); // blank line between nodes
    const idx = i + 1;
    const tok = formatTokens(Number.isFinite(n.estimatedTokens) ? n.estimatedTokens : 0);
    const head = `[${idx}] ${bold(n.id)} (${n.agentKind} · ~${tok} tok)`;

    // Dep marker — only meaningful when there are deps AND >1 node.
    const deps = Array.isArray(n.deps) ? n.deps : [];
    let depSuffix = "";
    if (nodeCount > 1 && deps.length > 0) {
      const positions = deps
        .map((d) => positionById.get(d))
        .filter((p): p is number => typeof p === "number")
        .sort((a, b) => a - b);
      if (positions.length > 0) {
        const tag = positions.map((p) => `[${p}]`).join(", ");
        depSuffix = `  ${cyan("⤴")} ${dim(`depends on ${tag}`)}`;
      }
    }
    lines.push(head + depSuffix);

    // Goal line.
    lines.push(`    ├─ goal: ${n.goal}`);

    // Scope line — truncate at maxScope.
    const scope = Array.isArray(n.scope) ? n.scope : [];
    if (scope.length > 0) {
      const shown = scope.slice(0, maxScope);
      const more = scope.length - shown.length;
      const suffix = more > 0 ? ` (+${more} more)` : "";
      lines.push(`    ├─ scope: ${shown.join(", ")}${suffix}`);
    } else {
      lines.push(`    ├─ scope: (none)`);
    }

    // Deps line — explicit list (or "none") at the bottom for clarity.
    if (deps.length === 0) {
      lines.push(`    └─ deps: none`);
    } else {
      lines.push(`    └─ deps: ${deps.join(", ")}`);
    }
  }

  lines.push("");
  lines.push(dim("Press y to execute, n to cancel, e to edit YAML."));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Topological sort — Kahn's algorithm with stable input-order tiebreaker.
// ---------------------------------------------------------------------------

function topoSort(nodes: readonly TaskNode[]): TaskNode[] {
  const byId = new Map<string, TaskNode>();
  const indegree = new Map<string, number>();
  const inputOrder = new Map<string, number>();

  nodes.forEach((n, i) => {
    byId.set(n.id, n);
    inputOrder.set(n.id, i);
    if (!indegree.has(n.id)) indegree.set(n.id, 0);
  });

  // Build adjacency list + indegrees from deps (deps point INTO a node).
  const successors = new Map<string, string[]>();
  for (const n of nodes) {
    const deps = Array.isArray(n.deps) ? n.deps : [];
    indegree.set(n.id, deps.filter((d) => byId.has(d)).length);
    for (const d of deps) {
      if (!byId.has(d)) continue;
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
      const prev = indegree.get(s) ?? 0;
      const next = prev - 1;
      indegree.set(s, next);
      if (next === 0 && !visited.has(s)) ready.push(s);
    }
    ready.sort((a, b) => (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0));
  }

  // Cycle fallback — validator should have rejected this, but be defensive.
  if (out.length < nodes.length) {
    for (const n of nodes) if (!visited.has(n.id)) out.push(n);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  // Round to nearest hundred so we get e.g. ~5,200 not ~5,237.
  const rounded = Math.round(n / 100) * 100;
  return rounded.toLocaleString("en-US");
}

function quote(s: string): string {
  return `"${s}"`;
}

function safeFallback(g: TaskGraph | null | undefined): string {
  try {
    const head = `Orchestration plan — goal: "${(g?.goal ?? "").toString()}"`;
    const count = Array.isArray(g?.nodes) ? g!.nodes.length : 0;
    const ids = Array.isArray(g?.nodes) ? g!.nodes.map((n) => String(n?.id ?? "?")).join(", ") : "";
    return `${head}\nnodes: ${count}${ids ? ` (${ids})` : ""}`;
  } catch {
    return "Orchestration plan — render fallback";
  }
}
