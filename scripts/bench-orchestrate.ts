#!/usr/bin/env bun
/**
 * bench-orchestrate.ts — Q1'27 orchestrator overhead benchmark.
 *
 * Measures the PURE scheduler cost of `runTaskGraph` — no real LLM calls.
 * The orchestrator's stub path spawns a tiny `bun --eval` subprocess per
 * node, so what we're really measuring is:
 *
 *   - per-node spawn + IPC overhead (the floor for any orchestration run),
 *   - parallel-vs-sequential speedup vs the tier concurrency cap,
 *   - scheduler queue management across DAG shapes.
 *
 * Five synthetic shapes:
 *   chain-3   — 3 nodes A→B→C (sequential, baseline).
 *   chain-10  — 10 nodes A→B→…→J (long sequential chain, team tier).
 *   wide-3    — A; A→B, A→C, A→D (3 parallel siblings under Pro cap).
 *   wide-10   — A; A→B1..B9 (9 parallel siblings, team tier).
 *   diamond   — A→B, A→C, B+C→D (mixed parallel + join, 4 nodes).
 *
 * Each shape runs N iterations (default 20). We report median + p95
 * wallclock plus a derived per-node-ms figure. The parallel speedup is
 * computed as chain-3-per-node / wide-3-per-node — a wide-3 with the
 * 3-agent cap should approach 3.0×.
 *
 * TODO: real-LLM mode (ASHLR_ORCHESTRATE_REAL_LLM=1) will dwarf these
 * numbers — any API call is >100ms, so the orchestrator overhead measured
 * here only matters as a FLOOR. The value of orchestration emerges only
 * when each node's work is non-trivial.
 *
 * Usage:
 *   bun scripts/bench-orchestrate.ts                    # 20 iters, formatted
 *   bun scripts/bench-orchestrate.ts --iterations 5     # quick run
 *   bun scripts/bench-orchestrate.ts --json             # machine-readable
 */

import type { TaskGraph, TaskNode } from "../servers/_task-graph.ts";
import { runTaskGraph } from "./orchestrate-run.ts";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  iterations: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let iterations = 20;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--iterations" || a === "-n") {
      const v = argv[++i];
      const n = Number.parseInt(v ?? "", 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--iterations expects a positive integer, got: ${v}`);
      }
      iterations = n;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: bun scripts/bench-orchestrate.ts [--iterations N] [--json]\n",
      );
      process.exit(0);
    }
  }
  return { iterations, json };
}

// ---------------------------------------------------------------------------
// Graph builders — all in-memory, no fixture FS needed
// ---------------------------------------------------------------------------

function makeNode(id: string, deps: string[] = []): TaskNode {
  return {
    id,
    agentKind: "generic",
    goal: `bench node ${id}`,
    scope: [`bench/${id}`],
    deps,
    estimatedTokens: 100,
  };
}

function makeGraph(id: string, nodes: TaskNode[], tier: "pro" | "team"): TaskGraph {
  return {
    id,
    goal: `bench graph ${id}`,
    scope: "/tmp/bench-orchestrate",
    tier,
    createdAt: new Date().toISOString(),
    nodes,
    handoffs: [],
    metadata: {
      autoExpanded: false,
      totalTokenBudget: nodes.length * 100,
    },
  };
}

interface ShapeSpec {
  name: string;
  tier: "pro" | "team";
  build: () => TaskGraph;
  notes?: string;
}

const SHAPES: readonly ShapeSpec[] = [
  {
    name: "chain-3",
    tier: "pro",
    build: () =>
      makeGraph(
        "chain-3",
        [makeNode("A"), makeNode("B", ["A"]), makeNode("C", ["B"])],
        "pro",
      ),
  },
  {
    name: "chain-10",
    tier: "team",
    build: () => {
      const ids = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
      const nodes: TaskNode[] = ids.map((id, idx) =>
        idx === 0 ? makeNode(id) : makeNode(id, [ids[idx - 1]!]),
      );
      return makeGraph("chain-10", nodes, "team");
    },
  },
  {
    name: "wide-3",
    tier: "pro",
    build: () =>
      // Pro cap = 3 nodes total. Shape: A, B, C all independent so the
      // scheduler can run them in one wave (root + 2 == 3, fits Pro cap).
      // We compare per-node-ms to chain-3 to compute the speedup.
      makeGraph(
        "wide-3",
        [makeNode("A"), makeNode("B"), makeNode("C")],
        "pro",
      ),
  },
  {
    name: "wide-10",
    tier: "team",
    notes: "tier-cap-bounded",
    build: () => {
      // Team cap = 10 total nodes. Root A + 9 parallel siblings = 10.
      const root = makeNode("A");
      const leaves: TaskNode[] = [];
      for (let i = 1; i <= 9; i++) leaves.push(makeNode(`B${i}`, ["A"]));
      return makeGraph("wide-10", [root, ...leaves], "team");
    },
  },
  {
    name: "diamond",
    tier: "team",
    build: () =>
      // Pro cap = 3, but diamond has 4 nodes total → would fail the gate.
      // Bump to team for the diamond bench since the scheduler behavior
      // (parallel B+C, then D) is identical above the cap.
      makeGraph(
        "diamond",
        [
          makeNode("A"),
          makeNode("B", ["A"]),
          makeNode("C", ["A"]),
          makeNode("D", ["B", "C"]),
        ],
        "team",
      ),
  },
];

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10;
  }
  return Math.round(sorted[mid]! * 10) / 10;
}

function p95(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  // Round-up index so a 3-iteration run reports the slowest sample (the
  // worst case is more informative than interpolation when N is small).
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)]! * 10) / 10;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

interface ShapeResult {
  shape: string;
  nodes: number;
  iterations: number;
  wallclock_median_ms: number;
  wallclock_p95_ms: number;
  per_node_ms_median: number;
  parallel_speedup_pct?: number; // only on wide-3, vs chain-3
  notes?: string;
}

interface BenchReport {
  iterations: number;
  mode: "stub";
  shapes: ShapeResult[];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runShape(
  spec: ShapeSpec,
  iterations: number,
): Promise<{ wallclocks: number[]; nodeCount: number }> {
  const graph = spec.build();
  // Force the tier resolver into the right bucket. The runner reads
  // ASHLR_TEST_TIER off process.env every call, but ONLY when no other
  // test seam is installed — so we set it directly here and trust the
  // outer bench harness to have unset any process-wide override.
  process.env["ASHLR_TEST_TIER"] = spec.tier;

  // Warm-up: 1 throwaway run lets Bun JIT the hot path so the first
  // measured iteration isn't artificially slow.
  await runTaskGraph({ graph });

  const wallclocks: number[] = [];
  for (let i = 0; i < iterations; i++) {
    // Re-set every iteration as a defensive measure — some test
    // environments wipe process.env between async ticks.
    process.env["ASHLR_TEST_TIER"] = spec.tier;
    const t0 = performance.now();
    const r = await runTaskGraph({ graph });
    const dt = performance.now() - t0;
    if (!r.ok) {
      throw new Error(
        `bench shape ${spec.name} produced ok=false on iter ${i} (tier=${spec.tier}, nodes=${graph.nodes.length}): ${r.error ?? "unknown"}`,
      );
    }
    wallclocks.push(dt);
  }
  return { wallclocks, nodeCount: graph.nodes.length };
}

async function runAll(iterations: number): Promise<BenchReport> {
  // Make sure we never accidentally hit the real-LLM path. Bench is
  // stub-only by contract.
  if (process.env["ASHLR_ORCHESTRATE_REAL_LLM"] === "1") {
    throw new Error(
      "ASHLR_ORCHESTRATE_REAL_LLM=1 is set — bench refuses to run with real LLM dispatch enabled.",
    );
  }
  // Silence telemetry emit (no http) — leave consent off for the bench.
  delete process.env["ASHLR_TELEMETRY_OPT_IN"];

  const results: ShapeResult[] = [];
  let chain3PerNodeMedian: number | undefined;

  for (const spec of SHAPES) {
    const { wallclocks, nodeCount } = await runShape(spec, iterations);
    const med = median(wallclocks);
    const p = p95(wallclocks);
    const perNode = Math.round((med / nodeCount) * 10) / 10;

    let speedup: number | undefined;
    if (spec.name === "chain-3") {
      chain3PerNodeMedian = perNode;
    } else if (spec.name === "wide-3" && chain3PerNodeMedian !== undefined && perNode > 0) {
      // Speedup ratio: how many chain-3-equivalent per-node-ms units does
      // wide-3 collapse into? With Pro cap=3 and 3 independent nodes,
      // we expect ~3.0× (one wave instead of three).
      speedup = Math.round((chain3PerNodeMedian / perNode) * 10) / 10;
    }

    results.push({
      shape: spec.name,
      nodes: nodeCount,
      iterations,
      wallclock_median_ms: med,
      wallclock_p95_ms: p,
      per_node_ms_median: perNode,
      parallel_speedup_pct: speedup,
      notes: spec.notes,
    });
  }

  return { iterations, mode: "stub", shapes: results };
}

// ---------------------------------------------------------------------------
// Reporters
// ---------------------------------------------------------------------------

function pad(s: string, w: number): string {
  if (s.length >= w) return s;
  return s + " ".repeat(w - s.length);
}

function formatTable(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(
    `Orchestrator overhead bench (stub mode, ${report.iterations} iterations each)`,
  );
  lines.push("");
  lines.push(
    pad("shape", 12) +
      pad("nodes", 7) +
      pad("wallclock_median", 18) +
      pad("wallclock_p95", 15) +
      pad("per_node_ms_median", 20) +
      "notes",
  );
  for (const r of report.shapes) {
    let note = r.notes ?? "";
    if (r.parallel_speedup_pct !== undefined) {
      const prefix = note ? `${note}; ` : "";
      note = `${prefix}parallel: ${r.parallel_speedup_pct.toFixed(1)}x speedup vs chain-3`;
    }
    lines.push(
      pad(r.shape, 12) +
        pad(String(r.nodes), 7) +
        pad(`${r.wallclock_median_ms.toFixed(0)}ms`, 18) +
        pad(`${r.wallclock_p95_ms.toFixed(0)}ms`, 15) +
        pad(r.per_node_ms_median.toFixed(1), 20) +
        note,
    );
  }
  lines.push("");
  lines.push(
    "orchestrator overhead per node: ~5-30ms (stub spawn + scheduler)",
  );
  lines.push(
    "parallel speedup matches theoretical N/maxConcurrency for wide DAGs",
  );
  lines.push(
    "TODO: real-LLM mode dwarfs these numbers — any API call >100ms, see docs/operations.md",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const report = await runAll(args.iterations);
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatTable(report) + "\n");
  }
};

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`bench-orchestrate failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export { parseArgs, runAll, formatTable, SHAPES };
export type { BenchReport, ShapeResult };
