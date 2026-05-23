/**
 * orchestrate-render.test.ts — Track B rich renderer.
 *
 * Anchors: numbered topo order, scope truncation, color-off default, edge
 * cases (empty + single-node), header summary.
 *
 * Targets the Track A schema landed in main (TaskGraph requires id/createdAt/
 * handoffs/metadata; tier is "pro" | "team"; node deps is string[]).
 */

import { describe, expect, test } from "bun:test";
import { renderTaskGraph } from "../servers/_task-graph-render";
import type { TaskGraph } from "../servers/_task-graph";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    id: "g-render-0001",
    goal: "add freshness logging to genome surfaces",
    scope: "/tmp/work/servers",
    tier: "pro",
    createdAt: "2027-01-01T00:00:00.000Z",
    nodes: [],
    handoffs: [],
    metadata: { autoExpanded: true, totalTokenBudget: 0 },
    ...overrides,
  };
}

const ANSI = /\x1b\[/;

// ---------------------------------------------------------------------------
// Topological numbering
// ---------------------------------------------------------------------------

describe("renderTaskGraph — topological numbering", () => {
  test("3-chain A→B→C renders nodes in order [1] [2] [3]", () => {
    const g = makeGraph({
      nodes: [
        // Intentionally listed out of topological order to prove the renderer
        // sorts on deps rather than input order.
        { id: "node-c", agentKind: "refactorer", goal: "C step", scope: ["src/c.ts"], deps: ["node-b"], estimatedTokens: 5000 },
        { id: "node-a", agentKind: "refactorer", goal: "A step", scope: ["src/a.ts"], deps: [], estimatedTokens: 5000 },
        { id: "node-b", agentKind: "refactorer", goal: "B step", scope: ["src/b.ts"], deps: ["node-a"], estimatedTokens: 5000 },
      ],
      metadata: { autoExpanded: true, totalTokenBudget: 15000 },
    });
    const out = renderTaskGraph(g);
    const ai = out.indexOf("node-a");
    const bi = out.indexOf("node-b");
    const ci = out.indexOf("node-c");
    expect(ai).toBeGreaterThan(-1);
    expect(bi).toBeGreaterThan(ai);
    expect(ci).toBeGreaterThan(bi);
    expect(out).toContain("[1]");
    expect(out).toContain("[2]");
    expect(out).toContain("[3]");
  });

  test("diamond DAG (A→B, A→C, B+C→D) renders A first, D last", () => {
    const g = makeGraph({
      nodes: [
        { id: "node-d", agentKind: "refactorer", goal: "D", scope: ["d"], deps: ["node-b", "node-c"], estimatedTokens: 3000 },
        { id: "node-b", agentKind: "refactorer", goal: "B", scope: ["b"], deps: ["node-a"], estimatedTokens: 3000 },
        { id: "node-c", agentKind: "refactorer", goal: "C", scope: ["c"], deps: ["node-a"], estimatedTokens: 3000 },
        { id: "node-a", agentKind: "refactorer", goal: "A", scope: ["a"], deps: [], estimatedTokens: 3000 },
      ],
      metadata: { autoExpanded: true, totalTokenBudget: 12000 },
    });
    const out = renderTaskGraph(g);
    const ai = out.indexOf("node-a");
    const bi = out.indexOf("node-b");
    const ci = out.indexOf("node-c");
    const di = out.indexOf("node-d");
    expect(ai).toBeLessThan(bi);
    expect(ai).toBeLessThan(ci);
    expect(bi).toBeLessThan(di);
    expect(ci).toBeLessThan(di);
  });
});

// ---------------------------------------------------------------------------
// Scope truncation
// ---------------------------------------------------------------------------

describe("renderTaskGraph — scope truncation", () => {
  test("maxScopeFiles=2 truncates 5-file scope to first two + (+3 more)", () => {
    const g = makeGraph({
      nodes: [
        {
          id: "node-big",
          agentKind: "refactorer",
          goal: "wide",
          scope: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
          deps: [],
          estimatedTokens: 5000,
        },
      ],
      metadata: { autoExpanded: true, totalTokenBudget: 5000 },
    });
    const out = renderTaskGraph(g, { maxScopeFiles: 2 });
    expect(out).toContain("a.ts, b.ts");
    expect(out).toContain("(+3 more)");
    expect(out).not.toContain("c.ts");
  });

  test("default maxScopeFiles is 5 — 5-file scope shown in full", () => {
    const g = makeGraph({
      nodes: [
        {
          id: "node-exact",
          agentKind: "refactorer",
          goal: "exact",
          scope: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
          deps: [],
          estimatedTokens: 5000,
        },
      ],
    });
    const out = renderTaskGraph(g);
    expect(out).toContain("a.ts, b.ts, c.ts, d.ts, e.ts");
    expect(out).not.toContain("(+0 more)");
    expect(out).not.toMatch(/\(\+\d+ more\)/);
  });
});

// ---------------------------------------------------------------------------
// Color handling
// ---------------------------------------------------------------------------

describe("renderTaskGraph — color", () => {
  test("color off by default — output contains no ANSI escapes", () => {
    const g = makeGraph({
      nodes: [
        { id: "node-a", agentKind: "refactorer", goal: "A", scope: ["a"], deps: [], estimatedTokens: 1000 },
      ],
    });
    const out = renderTaskGraph(g);
    expect(ANSI.test(out)).toBe(false);
  });

  test("color: true emits ANSI escapes", () => {
    const g = makeGraph({
      nodes: [
        { id: "node-a", agentKind: "refactorer", goal: "A", scope: ["a"], deps: [], estimatedTokens: 1000 },
        { id: "node-b", agentKind: "refactorer", goal: "B", scope: ["b"], deps: ["node-a"], estimatedTokens: 1000 },
      ],
    });
    const out = renderTaskGraph(g, { color: true });
    expect(ANSI.test(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("renderTaskGraph — edge cases", () => {
  test("0-node graph → 'empty graph' line", () => {
    const g = makeGraph({ nodes: [] });
    const out = renderTaskGraph(g);
    expect(out).toContain("empty graph (0 nodes)");
  });

  test("1-node graph → no 'depends on' markers", () => {
    const g = makeGraph({
      nodes: [
        { id: "node-solo", agentKind: "refactorer", goal: "solo", scope: ["x"], deps: [], estimatedTokens: 2000 },
      ],
    });
    const out = renderTaskGraph(g);
    expect(out).not.toContain("depends on");
    expect(out).toContain("[1]");
    expect(out).toContain("node-solo");
  });

  test("never throws — malformed graph falls back to plain text", () => {
    // Deliberately bypass typing to simulate a future schema drift / corrupt input.
    const bad = {
      id: "bad",
      goal: "bad",
      scope: "/tmp",
      tier: "pro",
      createdAt: "now",
      // nodes is the wrong shape — should still not throw.
      nodes: [{ id: "x" }],
      handoffs: [],
      metadata: { autoExpanded: false, totalTokenBudget: 0 },
    } as unknown as TaskGraph;
    expect(() => renderTaskGraph(bad)).not.toThrow();
    const out = renderTaskGraph(bad);
    expect(out).toContain("Orchestration plan");
  });
});

// ---------------------------------------------------------------------------
// Header summary
// ---------------------------------------------------------------------------

describe("renderTaskGraph — header", () => {
  test("includes node count + token budget", () => {
    const g = makeGraph({
      nodes: [
        { id: "n1", agentKind: "refactorer", goal: "1", scope: ["a"], deps: [], estimatedTokens: 5000 },
        { id: "n2", agentKind: "refactorer", goal: "2", scope: ["b"], deps: ["n1"], estimatedTokens: 4000 },
        { id: "n3", agentKind: "refactorer", goal: "3", scope: ["c"], deps: ["n2"], estimatedTokens: 5500 },
      ],
      metadata: { autoExpanded: true, totalTokenBudget: 14500 },
    });
    const out = renderTaskGraph(g);
    expect(out).toContain("3 nodes");
    expect(out).toContain("token budget");
    // Rounded to nearest 100 → "14,500"
    expect(out).toContain("14,500");
  });

  test("includes the goal in quotes", () => {
    const g = makeGraph({
      goal: "ship feature X",
      nodes: [
        { id: "n1", agentKind: "refactorer", goal: "1", scope: [], deps: [], estimatedTokens: 1000 },
      ],
    });
    const out = renderTaskGraph(g);
    expect(out).toContain('goal: "ship feature X"');
  });

  test("scope: line carries the graph-level scope", () => {
    const g = makeGraph({
      scope: "/repo/servers",
      nodes: [
        { id: "n1", agentKind: "refactorer", goal: "1", scope: [], deps: [], estimatedTokens: 1000 },
      ],
    });
    const out = renderTaskGraph(g);
    expect(out).toContain("scope: /repo/servers");
  });

  test("per-node line carries agent kind + token budget", () => {
    const g = makeGraph({
      nodes: [
        { id: "n1", agentKind: "test-writer", goal: "1", scope: [], deps: [], estimatedTokens: 5200 },
      ],
    });
    const out = renderTaskGraph(g);
    expect(out).toContain("test-writer");
    expect(out).toContain("~5,200 tok");
  });

  test("ends with the y/n/e prompt", () => {
    const g = makeGraph({
      nodes: [
        { id: "n1", agentKind: "refactorer", goal: "1", scope: [], deps: [], estimatedTokens: 1000 },
      ],
    });
    const out = renderTaskGraph(g);
    expect(out).toContain("Press y to execute, n to cancel, e to edit YAML.");
  });
});
