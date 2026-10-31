# Orchestrator benchmark notes

[`scripts/bench-orchestrate.ts`](../scripts/bench-orchestrate.ts) measures local
`runTaskGraph` wall-clock time on synthetic graphs. Each node runs a tiny
`bun --eval` stub subprocess. The timings include subprocess startup and IPC,
scheduler and dependency handling, and other work inside the runner, including
best-effort result persistence. They are not an isolated measurement of the
scheduler alone. No real LLM or provider API is called.

## Run it

From the repository root with Bun installed:

```sh
bun scripts/bench-orchestrate.ts                    # 20 iterations, formatted
bun scripts/bench-orchestrate.ts --iterations 5     # quick run
bun scripts/bench-orchestrate.ts --json             # machine-readable
```

`-n 5` is shorthand for `--iterations 5`; options can be combined. The script
does one unreported warm-up per shape before the requested measured iterations.
It sets the test tier for each shape and disables telemetry consent in its own
process. The runner also attempts to write results under
`~/.ashlr/orchestrations/<graph-id>/result.json`, reusing the shape names as
graph IDs. Use a temporary `HOME` if those files should be isolated from
existing orchestration results: the runner also prunes older orchestration
directories beyond its 50-most-recent retention limit.

## Workloads

Each row lists the node dependencies; a node with no dependency is written
alone. Pro and team select the runner's caps of 3 and 10 respectively.

| Shape | Tier | Dependencies |
| --- | --- | --- |
| chain-3 | pro | A; B:A; C:B |
| chain-10 | team | A; B:A; C:B; D:C; E:D; F:E; G:F; H:G; I:H; J:I |
| wide-3 | pro | A; B; C |
| wide-10 | team | A; B1:A; B2:A; B3:A; B4:A; B5:A; B6:A; B7:A; B8:A; B9:A |
| diamond | team | A; B:A; C:A; D:B,C |

The three `wide-3` nodes are independent and can run in one wave. In
`wide-10`, the nine leaves wait for A; in `diamond`, D waits for both B and C.

## Reading the report

For each shape the report gives the median and nearest-rank p95 of measured
wall-clock samples. The median is rounded to 0.1 ms; for an even sample count
it averages the two middle values. The p95 uses the sample at rank
`ceil(0.95 * N)`, rounded to 0.1 ms. `per_node_ms_median` divides the rounded
median by the number of nodes and rounds to 0.1 ms: it is a normalized graph
time, not the measured duration of an individual node, especially when nodes
run concurrently.

For `wide-3`, the JSON field `parallel_speedup_pct` is a **ratio**, despite
its name: rounded `chain-3` per-node median divided by rounded `wide-3`
per-node median, rounded to one decimal. The table displays it as a multiplier.
It is omitted if the wide per-node value rounds to zero. Timing and ratios vary
with machine, operating system, and load; the table's fixed summary lines are
guidance, not measurements from that run. Compare repeated runs in a similar
environment, and use more iterations than the quick example for comparisons.

## Real-LLM limitation

This is a stub-only benchmark. It refuses to run when
`ASHLR_ORCHESTRATE_REAL_LLM=1`; that flag selects a different executor in the
runner and is not a benchmark option. The local stub results provide a useful
overhead baseline, but do not measure provider latency, model work, token
usage, answer quality, cost, or end-to-end speedup with real agents. In
particular, the script's >100 ms API-call comment and fixed timing estimates
are not measurements of real calls or guarantees about every provider. A
real-workload comparison needs its own representative tasks, provider and
model settings, repeated measurements, and a sequential baseline.

See [benchmarks.md](benchmarks.md) for the separate token-savings benchmarks
and [operations.md](operations.md#9-performance-characteristics) for the
orchestrator runbook.
