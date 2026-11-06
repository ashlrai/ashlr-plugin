import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHAPES } from "../scripts/bench-orchestrate.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

const doc = read("docs/benchmarks.md");
const script = read("scripts/bench-orchestrate.ts");

describe("benchmarks.md real-LLM limitation matches bench-orchestrate.ts", () => {
  test("documents the stub-only contract and the real-LLM refusal", () => {
    // The script throws when the real-LLM flag is set — the doc must say so.
    expect(script).toContain('process.env["ASHLR_ORCHESTRATE_REAL_LLM"] === "1"');
    expect(script).toContain("refuses to run");
    expect(doc).toContain("scripts/bench-orchestrate.ts");
    expect(doc).toContain("ASHLR_ORCHESTRATE_REAL_LLM=1");
    expect(doc).toMatch(/stub-only/);
    expect(doc).toMatch(/refuses to run/);
  });

  test("does not treat the script's API-call estimate as measured data", () => {
    const threshold = script.match(/any API call is ?>\s*(\d+)\s*ms/)?.[1];
    expect(threshold).toBeDefined();
    expect(doc).toContain(`>${threshold}ms`);
    expect(script).toMatch(/only matters as a FLOOR/);
    expect(doc).toMatch(/floor/i);
    expect(doc).toMatch(/non-trivial/);
    expect(doc).toMatch(/not a measurement or a\s+guarantee/);
    expect(doc).toMatch(/not an isolated\s+scheduler measurement/);
  });

  test("documents the same DAG shapes the bench runs", () => {
    // The SHAPES array literal ends with a `];` at column 0 — later `];`
    // inside builders (e.g. chain-10's `ids` array) are indented.
    const start = script.indexOf("const SHAPES");
    const block = script.slice(start, script.indexOf("\n];", start));
    const names = [...block.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["chain-3", "chain-10", "wide-3", "wide-10", "diamond"]);
    for (const name of names) {
      expect(doc).toContain(name);
    }
  });
});

describe("orchestrator benchmark notes", () => {
  const notes = read("docs/orchestrate-benchmark-notes.md");

  test("describe the graphs actually built by the benchmark", () => {
    for (const shape of SHAPES) {
      const graph = shape.build();
      const dependencies = graph.nodes
        .map((node) => node.deps.length ? `${node.id}:${node.deps.join(",")}` : node.id)
        .join("; ");
      expect(notes).toContain(`| ${shape.name} | ${shape.tier} | ${dependencies} |`);
    }
  });

  test("provide the invocation and distinguish stub work from real LLMs", () => {
    expect(notes).toContain("bun scripts/bench-orchestrate.ts --iterations 5");
    expect(notes).toContain("bun scripts/bench-orchestrate.ts --json");
    expect(notes).toContain("ASHLR_ORCHESTRATE_REAL_LLM=1");
    expect(notes).toMatch(/refuses to run/);
    expect(notes).toMatch(/No real LLM or provider API is called/);
    expect(notes).toMatch(/not the measured duration of an individual node/);
  });
});

describe("orchestrator benchmark interpretation", () => {
  const guide = read("docs/orchestrate-benchmark-interpretation.md");

  test("covers every benchmark graph and describes the reported statistics", () => {
    for (const shape of SHAPES) expect(guide).toContain(`\`${shape.name}\``);
    for (const field of ["wallclock_median_ms", "wallclock_p95_ms", "per_node_ms_median", "parallel_speedup_pct"]) {
      expect(guide).toContain(`\`${field}\``);
    }
    expect(guide).toContain("ceil(0.95 * N)");
    expect(guide).toMatch(/multiplier, computed from the rounded/);
    expect(guide).toMatch(/not an individual node's\s+elapsed time/);
  });

  test("explains isolation and distinguishes the unimplemented benchmark mode from the executor", () => {
    expect(guide).toContain('HOME="$bench_home" bun scripts/bench-orchestrate.ts --iterations 20 --json');
    expect(guide).toContain("one unreported warm-up");
    expect(guide).toContain("ASHLR_ORCHESTRATE_REAL_LLM=1");
    expect(guide).toMatch(/real-LLM mode is \*\*unimplemented\*\*/);
    expect(guide).toMatch(/separate flag-gated\s+LLM executor/);
    expect(guide).toMatch(/benchmark never invokes it/);
    expect(read("docs/README.md")).toContain("orchestrate-benchmark-interpretation.md");
  });
});

describe("real-LLM benchmark status", () => {
  const status = read("docs/orchestrate-real-llm-benchmark-status.md");

  test("tracks the stub-only contract and the script's latency caveat", () => {
    const threshold = script.match(/any API call is ?>\s*(\d+)\s*ms/)?.[1];
    expect(threshold).toBeDefined();
    expect(status).toMatch(/TODO: real-LLM benchmark mode is not implemented/);
    expect(status).toContain('`mode: "stub"`');
    expect(status).toMatch(/refuses to run when\s+`ASHLR_ORCHESTRATE_REAL_LLM=1`/);
    expect(status).toContain(`>${threshold}ms`);
    expect(status).toMatch(/not a measurement or guarantee/);
    expect(status).toMatch(/not a universal lower bound/);
    expect(status).toMatch(/separate flag-gated real-LLM executor/);
    expect(read("docs/README.md")).toContain("orchestrate-real-llm-benchmark-status.md");
  });
});

describe("real-LLM benchmark note", () => {
  const note = read("docs/orchestrate-real-llm-benchmark-note.md");

  test("identifies the future real-LLM mode and where it is wired", () => {
    expect(note).toContain("ASHLR_ORCHESTRATE_REAL_LLM=1");
    expect(note).toMatch(/real-LLM mode is \*\*unimplemented\*\*/);
    expect(note).toContain('`mode: "stub"`');
    expect(note).toMatch(/refuses to run when `ASHLR_ORCHESTRATE_REAL_LLM=1` is set/);
    // The flag is already honored by the runner's executor, not the bench.
    expect(note).toContain("scripts/orchestrate-run.ts");
    expect(note).toContain("servers/_orchestrate-executor.ts");
    expect(note).toContain("executeNodeLlm");
  });

  test("repeats the script's timing caveat without treating it as measured", () => {
    const threshold = script.match(/any API call is ?>\s*(\d+)\s*ms/)?.[1];
    expect(threshold).toBeDefined();
    expect(note).toContain(`>${threshold}ms`);
    expect(note).toMatch(/floor/i);
    expect(note).toMatch(/~5-30ms/);
    expect(note).toMatch(/stated commentary, not measurements/);
    expect(note).toMatch(/non-trivial/);
    expect(read("docs/README.md")).toContain("orchestrate-real-llm-benchmark-note.md");
  });
});

describe("orchestrator benchmark scope", () => {
  const scope = read("docs/orchestrate-benchmark-scope.md");

  test("cites the script as the source of the stated real-LLM limitation", () => {
    expect(scope).toContain("scripts/bench-orchestrate.ts");
    // The header's own words pin the limitation: stub work, no real LLM calls.
    expect(script).toContain("no real LLM calls");
    expect(scope).toContain("no real LLM calls");
    for (const shape of SHAPES) expect(scope).toContain(shape.name);
    expect(scope).toContain('`mode: "stub"`');
    expect(scope).toContain("ASHLR_ORCHESTRATE_REAL_LLM=1");
    expect(scope).toMatch(/refuses to run/);
    expect(scope).toContain("bench refuses to run with real LLM dispatch enabled");
  });

  test("repeats the script's floor caveat without treating it as measured", () => {
    const threshold = script.match(/any API call is ?>\s*(\d+)\s*ms/)?.[1];
    expect(threshold).toBeDefined();
    expect(scope).toContain(`>${threshold}ms`);
    expect(scope).toMatch(/FLOOR/);
    expect(scope).toMatch(/non-trivial/);
    expect(scope).toMatch(/stated assumption, not a measurement/);
    // The doc points at where the flag is wired without claiming the bench uses it.
    expect(scope).toContain("scripts/orchestrate-run.ts");
    expect(scope).toContain("servers/_orchestrate-executor.ts");
    expect(scope).toContain("executeNodeLlm");
    expect(read("docs/README.md")).toContain("orchestrate-benchmark-scope.md");
  });
});
