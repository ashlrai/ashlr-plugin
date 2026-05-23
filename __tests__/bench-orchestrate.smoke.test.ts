/**
 * bench-orchestrate.smoke.test.ts — Q1'27 orchestration overhead bench smoke.
 *
 * Spawns `bun scripts/bench-orchestrate.ts --iterations 3 --json` as a real
 * subprocess and asserts:
 *   - exit code 0
 *   - stdout is parseable JSON
 *   - all 5 shape names appear in the result
 *   - per_node_ms_median < 100 for every shape (orchestrator overhead is bounded)
 *   - wide-3's parallel_speedup_pct is between 1.5 and 4 (theoretical ~3x)
 *
 * --iterations 3 keeps the smoke under ~5s; uses tier=team via ASHLR_TEST_TIER
 * pass-through inside the bench so no pro-cache is required. Marked `.smoke`
 * so it doesn't bloat the main test loop (still picked up by `bun test`).
 */

import { describe, expect, test } from "bun:test";
import { join } from "path";
import { spawnSync } from "child_process";

const SHAPE_NAMES = ["chain-3", "chain-10", "wide-3", "wide-10", "diamond"] as const;

describe("bench-orchestrate smoke", () => {
  test("--iterations 3 --json runs cleanly and reports bounded overhead", () => {
    const script = join(import.meta.dir, "..", "scripts", "bench-orchestrate.ts");
    const result = spawnSync(
      "bun",
      [script, "--iterations", "3", "--json"],
      {
        encoding: "utf-8",
        timeout: 30_000,
        env: {
          ...process.env,
          // Strip any inherited real-LLM flag — bench refuses to run with it.
          ASHLR_ORCHESTRATE_REAL_LLM: "",
          // Turn off telemetry consent for hermetic runs.
          ASHLR_TELEMETRY_OPT_IN: "",
        },
      },
    );

    if (result.status !== 0) {
      // Surface stderr in the assertion failure so CI knows what blew up.
      throw new Error(
        `bench-orchestrate exited ${result.status}: ${result.stderr ?? ""}\n--- stdout ---\n${result.stdout ?? ""}`,
      );
    }
    expect(result.status).toBe(0);

    const stdout = (result.stdout ?? "").trim();
    expect(stdout.length).toBeGreaterThan(0);

    // Stdout must be parseable JSON (the --json mode emits one object).
    let parsed: {
      iterations: number;
      mode: string;
      shapes: Array<{
        shape: string;
        nodes: number;
        per_node_ms_median: number;
        wallclock_median_ms: number;
        parallel_speedup_pct?: number;
      }>;
    };
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new Error(`bench-orchestrate stdout was not parseable JSON: ${stdout.slice(0, 500)}`);
    }

    expect(parsed.mode).toBe("stub");
    expect(parsed.iterations).toBe(3);
    expect(Array.isArray(parsed.shapes)).toBe(true);
    expect(parsed.shapes.length).toBe(SHAPE_NAMES.length);

    // Every expected shape name appears, exactly once.
    const seen = new Set(parsed.shapes.map((s) => s.shape));
    for (const name of SHAPE_NAMES) {
      expect(seen.has(name)).toBe(true);
    }

    // Orchestrator overhead is bounded: per_node_ms_median < 100ms for every
    // shape. Stub mode runs `bun --eval` per node, so ~5-30ms per node is
    // typical on a developer laptop and CI runners. 100ms is a generous
    // upper bound that flags any pathological regression (e.g., a sleep or
    // a synchronous DB hit landing in the scheduler hot path).
    for (const s of parsed.shapes) {
      expect(s.per_node_ms_median).toBeLessThan(100);
      expect(s.per_node_ms_median).toBeGreaterThanOrEqual(0);
    }

    // Parallel speedup sanity bounds. wide-3 (3 independent nodes under the
    // Pro cap of 3) should approach 3x vs chain-3 (3 sequential nodes).
    // Allow a wide range [1.5, 4] to tolerate scheduling noise on CI.
    const wide3 = parsed.shapes.find((s) => s.shape === "wide-3");
    expect(wide3).toBeDefined();
    const speedup = wide3?.parallel_speedup_pct;
    expect(typeof speedup).toBe("number");
    expect(speedup as number).toBeGreaterThanOrEqual(1.5);
    expect(speedup as number).toBeLessThanOrEqual(4);
  }, 30_000);
});
