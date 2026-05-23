/**
 * _task-graph-render.ts — Track B scaffold for the dry-run renderer.
 *
 * Renders a TaskGraph as a compact ASCII DAG preview. The full Track B
 * impl emits colored Unicode tree-art and per-node ROI; this scaffold
 * gives the slash command + integration tests a stable, deterministic
 * output to assert against.
 *
 * Targets the Track A schema (agentKind, deps, estimatedTokens,
 * handoffs, metadata) — when Track B lands it replaces this file but
 * keeps the same `renderTaskGraph` signature.
 */

import type { TaskGraph } from "./_task-graph.ts";

export interface RenderOptions {
  /** Enable ANSI color sequences when stdout is a TTY. */
  color?: boolean;
  /** Truncate per-node scope listings beyond this many entries. */
  maxScopeFiles?: number;
}

export function renderTaskGraph(g: TaskGraph, opts: RenderOptions = {}): string {
  const maxScope = opts.maxScopeFiles ?? 3;
  const bold = (s: string) => (opts.color ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (opts.color ? `\x1b[2m${s}\x1b[0m` : s);
  const out: string[] = [];
  out.push(bold("Orchestration plan"));
  out.push(`  goal: ${g.goal}`);
  out.push(`  scope: ${g.scope}`);
  out.push(`  tier: ${g.tier}`);
  out.push(`  nodes: ${g.nodes.length}`);
  if (g.metadata && typeof g.metadata.totalTokenBudget === "number") {
    out.push(`  budget: ~${g.metadata.totalTokenBudget} tokens`);
  }
  out.push("");
  for (const n of g.nodes) {
    const dep = n.deps && n.deps.length > 0 ? ` ← ${n.deps.join(", ")}` : "";
    out.push(`  ${bold(n.id)} [${n.agentKind}]${dim(dep)}`);
    out.push(`    ${n.goal}`);
    if (n.scope && n.scope.length > 0) {
      const shown = n.scope.slice(0, maxScope);
      const more = n.scope.length > maxScope ? ` (+${n.scope.length - maxScope} more)` : "";
      out.push(dim(`    scope: ${shown.join(", ")}${more}`));
    }
    out.push(dim(`    budget: ~${n.estimatedTokens} tokens`));
  }
  if (g.handoffs && g.handoffs.length > 0) {
    out.push("");
    out.push(dim(`  handoffs: ${g.handoffs.length}`));
  }
  return out.join("\n");
}
