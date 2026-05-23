/**
 * task-graph.test.ts — Track A contract verification.
 *
 * Locks the shape of TaskGraph + the behavior of validateTaskGraph / toYaml /
 * fromYaml. Sibling tracks B and C consume these — breaking changes here
 * MUST be coordinated.
 */

import { describe, test, expect } from "bun:test";
import {
  validateTaskGraph,
  toYaml,
  fromYaml,
  type TaskGraph,
} from "../servers/_task-graph";

function happyGraph(): TaskGraph {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    goal: "Refactor auth subsystem",
    scope: "server/src/auth",
    tier: "pro",
    createdAt: "2027-01-15T12:00:00.000Z",
    nodes: [
      {
        id: "node-types",
        agentKind: "refactorer",
        goal: "Update auth types",
        scope: ["server/src/auth/types.ts"],
        deps: [],
        estimatedTokens: 2400,
      },
      {
        id: "node-routes",
        agentKind: "refactorer",
        goal: "Refactor routes",
        scope: ["server/src/auth/routes.ts"],
        deps: ["node-types"],
        estimatedTokens: 3200,
      },
      {
        id: "node-tests",
        agentKind: "test-writer",
        goal: "Update tests",
        scope: ["server/src/auth/__tests__"],
        deps: ["node-routes"],
        estimatedTokens: 1800,
      },
    ],
    handoffs: [
      {
        fromNode: "node-types",
        toNode: "node-routes",
        contextSummary: "Types renamed: UserId → AccountId",
      },
    ],
    metadata: {
      autoExpanded: true,
      totalTokenBudget: 7400,
    },
  };
}

describe("validateTaskGraph — happy path", () => {
  test("accepts a well-formed graph and narrows the result", () => {
    const r = validateTaskGraph(happyGraph());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph.nodes).toHaveLength(3);
      expect(r.graph.handoffs).toHaveLength(1);
      expect(r.graph.metadata.autoExpanded).toBe(true);
    }
  });

  test("accepts an empty handoffs array", () => {
    const g = happyGraph();
    g.handoffs = [];
    const r = validateTaskGraph(g);
    expect(r.ok).toBe(true);
  });
});

describe("validateTaskGraph — missing required fields", () => {
  test("rejects null / non-object input", () => {
    const r = validateTaskGraph(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("root");
  });

  test("rejects missing id / goal / scope / tier / createdAt / metadata", () => {
    const r = validateTaskGraph({ nodes: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const joined = r.errors.join("\n");
      expect(joined).toContain("id:");
      expect(joined).toContain("goal:");
      expect(joined).toContain("scope:");
      expect(joined).toContain("tier:");
      expect(joined).toContain("createdAt:");
      expect(joined).toContain("metadata:");
    }
  });

  test("rejects missing node fields", () => {
    const g = happyGraph();
    (g.nodes[0] as unknown as Record<string, unknown>).estimatedTokens = "lots";
    const r = validateTaskGraph(g);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("estimatedTokens");
  });

  test("rejects unknown agentKind", () => {
    const g = happyGraph();
    (g.nodes[0] as unknown as Record<string, unknown>).agentKind = "necromancer";
    const r = validateTaskGraph(g);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("agentKind: unknown 'necromancer'");
  });

  test("rejects unknown dep reference", () => {
    const g = happyGraph();
    g.nodes[1]!.deps = ["node-ghost"];
    const r = validateTaskGraph(g);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("references unknown node 'node-ghost'");
  });
});

describe("validateTaskGraph — cycle detection", () => {
  test("flags a 2-node cycle", () => {
    const g = happyGraph();
    g.nodes = [
      { id: "a", agentKind: "generic", goal: "A", scope: [], deps: ["b"], estimatedTokens: 1 },
      { id: "b", agentKind: "generic", goal: "B", scope: [], deps: ["a"], estimatedTokens: 1 },
    ];
    g.handoffs = [];
    const r = validateTaskGraph(g);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const cyc = r.errors.find((e) => e.startsWith("cycle:"));
      expect(cyc).toBeDefined();
      // Either "a -> b -> a" or "b -> a -> b"
      expect(cyc).toMatch(/cycle: (a -> b -> a|b -> a -> b)/);
    }
  });

  test("flags a 3-node cycle", () => {
    const g = happyGraph();
    g.nodes = [
      { id: "a", agentKind: "generic", goal: "A", scope: [], deps: ["b"], estimatedTokens: 1 },
      { id: "b", agentKind: "generic", goal: "B", scope: [], deps: ["c"], estimatedTokens: 1 },
      { id: "c", agentKind: "generic", goal: "C", scope: [], deps: ["a"], estimatedTokens: 1 },
    ];
    g.handoffs = [];
    const r = validateTaskGraph(g);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const cyc = r.errors.find((e) => e.startsWith("cycle:"));
      expect(cyc).toBeDefined();
      expect(cyc).toContain("->");
    }
  });

  test("self-loop is a cycle", () => {
    const g = happyGraph();
    g.nodes = [
      { id: "a", agentKind: "generic", goal: "A", scope: [], deps: ["a"], estimatedTokens: 1 },
    ];
    g.handoffs = [];
    const r = validateTaskGraph(g);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.find((e) => e.startsWith("cycle:"))).toBeDefined();
  });
});

describe("toYaml / fromYaml — round-trip", () => {
  test("happy graph round-trips losslessly", () => {
    const g = happyGraph();
    const y = toYaml(g);
    expect(y).toContain("goal:");
    expect(y).toContain("nodes:");
    const parsed = fromYaml(y);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.graph).toEqual(g);
    }
  });

  test("graph with empty handoffs round-trips", () => {
    const g = happyGraph();
    g.handoffs = [];
    const y = toYaml(g);
    const parsed = fromYaml(y);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.graph).toEqual(g);
  });

  test("graph with special characters in goal round-trips", () => {
    const g = happyGraph();
    g.goal = "Add 'logging' to Q1\n2027 — refactor: auth/billing";
    g.nodes[0]!.goal = "node #1: handle \"quoted\" strings & --flags";
    const y = toYaml(g);
    const parsed = fromYaml(y);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.graph).toEqual(g);
  });

  test("fromYaml returns error on malformed input", () => {
    const r = fromYaml("not\n  : valid\n   yaml");
    expect(r.ok).toBe(false);
  });

  test("fromYaml on toYaml then validate is idempotent", () => {
    const g = happyGraph();
    const once = toYaml(g);
    const parsed1 = fromYaml(once);
    expect(parsed1.ok).toBe(true);
    if (parsed1.ok) {
      const twice = toYaml(parsed1.graph);
      expect(twice).toBe(once);
    }
  });
});
