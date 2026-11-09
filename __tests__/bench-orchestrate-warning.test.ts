import { describe, expect, test } from "bun:test";
import { REAL_LLM_WARNING, formatTable, type BenchReport } from "../scripts/bench-orchestrate.ts";

const report: BenchReport = {
  iterations: 1,
  mode: "stub",
  warning: REAL_LLM_WARNING,
  shapes: [
    {
      shape: "chain-3",
      nodes: 3,
      iterations: 1,
      wallclock_median_ms: 30,
      wallclock_p95_ms: 30,
      per_node_ms_median: 10,
    },
  ],
};

describe("bench-orchestrate real-LLM warning", () => {
  test("warning says real-LLM latency is outside the local numbers", () => {
    expect(REAL_LLM_WARNING).toMatch(/exclude real-LLM latency/);
    expect(REAL_LLM_WARNING).toMatch(/outside/);
  });

  test("formatted table prints the warning", () => {
    expect(formatTable(report)).toContain(REAL_LLM_WARNING);
  });

  test("JSON report carries the warning for agents", () => {
    expect(JSON.parse(JSON.stringify(report)).warning).toBe(REAL_LLM_WARNING);
  });
});
