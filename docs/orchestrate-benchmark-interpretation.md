# Interpreting the orchestrator benchmark

[`scripts/bench-orchestrate.ts`](../scripts/bench-orchestrate.ts) measures local
wall-clock time for synthetic task graphs using stub subprocesses. It includes
Bun startup, IPC, scheduling, dependency handling, and best-effort result
persistence. These results describe the tested machine and workload; they do
not isolate scheduler cost or predict the latency of a production agent run.

## Collect a baseline

From the repository root, with Bun and dependencies installed, use an isolated
home directory: the runner writes results and can prune older orchestration
results under `~/.ashlr/orchestrations`.

```sh
bench_home=$(mktemp -d)
HOME="$bench_home" bun scripts/bench-orchestrate.ts --iterations 20 --json
```

The default is 20 measured iterations per shape, after one unreported warm-up.
The report labels its `mode` as `stub`. The script sets a test tier per shape
and disables telemetry consent in its process. Use the same machine, Bun
version, iteration count, and similar system load when comparing revisions;
repeat runs because process scheduling and filesystem activity introduce noise.
The JSON output retains decimal precision that the formatted table rounds for
display. See [benchmark notes](orchestrate-benchmark-notes.md) for the exact
workloads and invocation options.

## Read the numbers

- `wallclock_median_ms` is the median elapsed time for a complete graph run;
  `wallclock_p95_ms` is the nearest-rank p95 (rank `ceil(0.95 * N)`). With
  20 samples the p95 is the 19th sorted sample, not a reliable tail-latency
  guarantee. Both are rounded to 0.1 ms.
- `per_node_ms_median` is the rounded graph median divided by node count,
  rounded again to 0.1 ms. It is a normalization, not an individual node's
  elapsed time: concurrent nodes overlap.
- `parallel_speedup_pct` appears only for `wide-3` when its normalized value
  is nonzero. Despite its name it is a multiplier, computed from the rounded
  `chain-3` per-node median divided by the rounded `wide-3` value, then rounded
  to 0.1. For example, 30 ms / 12 ms gives 2.5x, not 2.5%. This is a
  comparison of two synthetic graphs, not a percentage or a real-agent speedup.

`chain-3` runs three dependent nodes sequentially; `wide-3` runs three
independent nodes in one possible wave. `chain-10` is a ten-node chain;
`wide-10` has a root followed by nine dependent leaves; `diamond` has a root,
two parallel branches, and a join. These shapes have different critical paths
and the pro and team tiers have different caps. A ratio near 3x for `wide-3`
is an idealized expectation, not a guaranteed outcome. Fixed timing and speedup
claims printed after the table are commentary, not statistics from the run.

## What real-LLM results would require

The benchmark's real-LLM mode is **unimplemented**: it refuses to run when
`ASHLR_ORCHESTRATE_REAL_LLM=1`. The orchestrator has a separate flag-gated
LLM executor, but this benchmark never invokes it. No model or provider is
called, so the report measures no provider latency, token use, cost, output
quality, or end-to-end benefit. The stub baseline is a local reference, not a
universal lower bound for real dispatch: the executor and workload differ.

To assess real workloads, design a separate experiment with representative
tasks and dependencies, equivalent sequential and parallel work, fixed model
and provider settings, repeated runs, and recorded latency, failures, token
usage, cost, and output quality. Account for rate limits and external load.
Do not infer those results from the stub benchmark or its fixed API-latency
comment.
