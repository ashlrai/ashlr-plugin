/**
 * orchestrate-expand.test.ts — Track A auto-expander behavior.
 *
 * Anchors:
 *   - tiny fixture under __tests__/fixtures/orchestrate-tiny/ has 3 modules:
 *     auth (3 files), billing (3 files), api (3 files) with cross-imports
 *     auth ← billing ← api.
 *   - expander on pro tier picks 3 nodes total.
 *   - deps mirror the import graph (billing depends on auth; api depends on
 *     both billing and auth).
 *   - total token budget falls within the spec'd bounds.
 *   - tier cap: artificially expand the candidate list with extra modules and
 *     assert the cap is enforced.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

import { expandToTaskGraph } from "../scripts/orchestrate-expand";
import { validateTaskGraph } from "../servers/_task-graph";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/orchestrate-tiny");

describe("expandToTaskGraph — tiny fixture", () => {
  test("pro tier on 3-module fixture → 3 nodes, deps follow imports", async () => {
    const g = await expandToTaskGraph({
      goal: "Add freshness logging",
      scope: FIXTURE,
      tier: "pro",
    });
    // Schema validates.
    const v = validateTaskGraph(g);
    expect(v.ok).toBe(true);

    // 3 nodes (one per module).
    expect(g.nodes).toHaveLength(3);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.has("node-auth")).toBe(true);
    expect(byId.has("node-billing")).toBe(true);
    expect(byId.has("node-api")).toBe(true);

    // auth has no module deps (it imports nothing from the fixture).
    expect(byId.get("node-auth")!.deps).toEqual([]);
    // billing imports auth.
    expect(byId.get("node-billing")!.deps).toContain("node-auth");
    // api imports both auth and billing.
    const apiDeps = new Set(byId.get("node-api")!.deps);
    expect(apiDeps.has("node-auth")).toBe(true);
    expect(apiDeps.has("node-billing")).toBe(true);
  });

  test("agent kinds are heuristic", async () => {
    const g = await expandToTaskGraph({
      goal: "Add freshness logging",
      scope: FIXTURE,
      tier: "pro",
    });
    // All three fixture modules are pure source — all should be refactorer.
    for (const n of g.nodes) {
      expect(n.agentKind).toBe("refactorer");
    }
  });

  test("total token budget is sane (within [2000, 20000] per node)", async () => {
    const g = await expandToTaskGraph({
      goal: "Add freshness logging",
      scope: FIXTURE,
      tier: "pro",
    });
    for (const n of g.nodes) {
      expect(n.estimatedTokens).toBeGreaterThanOrEqual(2000);
      expect(n.estimatedTokens).toBeLessThanOrEqual(20000);
    }
    const sum = g.nodes.reduce((s, n) => s + n.estimatedTokens, 0);
    expect(g.metadata.totalTokenBudget).toBe(sum);
  });

  test("metadata.autoExpanded is true", async () => {
    const g = await expandToTaskGraph({
      goal: "Add freshness logging",
      scope: FIXTURE,
      tier: "pro",
    });
    expect(g.metadata.autoExpanded).toBe(true);
    expect(g.metadata.sourceYaml).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tier cap
// ---------------------------------------------------------------------------

describe("expandToTaskGraph — tier caps", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ashlr-orchestrate-cap-"));
    // 5 modules, each with a single .ts file.
    for (const name of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
      await mkdir(join(tmpDir, name), { recursive: true });
      await writeFile(join(tmpDir, name, "index.ts"), `export const ${name} = "${name}";\n`, "utf-8");
    }
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("pro tier caps at 3 nodes when 5 modules exist", async () => {
    const g = await expandToTaskGraph({
      goal: "Refactor everything",
      scope: tmpDir,
      tier: "pro",
    });
    expect(g.nodes).toHaveLength(3);
  });

  test("team tier emits all 5 (since cap is 10 > 5)", async () => {
    const g = await expandToTaskGraph({
      goal: "Refactor everything",
      scope: tmpDir,
      tier: "team",
    });
    expect(g.nodes).toHaveLength(5);
  });

  test("explicit --max-nodes override respected", async () => {
    const g = await expandToTaskGraph({
      goal: "Refactor everything",
      scope: tmpDir,
      tier: "team",
      maxNodes: 2,
    });
    expect(g.nodes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Determinism + edge cases
// ---------------------------------------------------------------------------

describe("expandToTaskGraph — edge cases", () => {
  test("deterministic node selection given the same inputs", async () => {
    const g1 = await expandToTaskGraph({
      goal: "Add freshness logging",
      scope: FIXTURE,
      tier: "pro",
    });
    const g2 = await expandToTaskGraph({
      goal: "Add freshness logging",
      scope: FIXTURE,
      tier: "pro",
    });
    // ids + createdAt vary; nodes (sans id field on the graph itself) should match.
    const stripGraph = (g: typeof g1) => ({
      ...g,
      id: "fixed",
      createdAt: "fixed",
    });
    expect(stripGraph(g1)).toEqual(stripGraph(g2));
  });

  test("throws on non-existent scope", async () => {
    await expect(
      expandToTaskGraph({
        goal: "x",
        scope: "/path/that/does/not/exist/ever",
        tier: "pro",
      }),
    ).rejects.toThrow(/scope is not a directory/);
  });

  test("empty scope (no modules) → 0 nodes", async () => {
    const empty = await mkdtemp(join(tmpdir(), "ashlr-orchestrate-empty-"));
    try {
      const g = await expandToTaskGraph({ goal: "x", scope: empty, tier: "pro" });
      expect(g.nodes).toHaveLength(0);
      expect(g.metadata.totalTokenBudget).toBe(0);
    } finally {
      await rm(empty, { recursive: true, force: true }).catch(() => {});
    }
  });
});
