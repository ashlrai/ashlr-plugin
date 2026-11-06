# Real-LLM orchestrator benchmark note

Short note on where [`scripts/bench-orchestrate.ts`](../scripts/bench-orchestrate.ts)
stands relative to real LLM dispatch. For detail see the
[benchmark notes](orchestrate-benchmark-notes.md),
[interpretation guide](orchestrate-benchmark-interpretation.md), and
[status doc](orchestrate-real-llm-benchmark-status.md).

## Future real-LLM mode

`ASHLR_ORCHESTRATE_REAL_LLM=1` is the flag that will select real-LLM dispatch.
In [`scripts/orchestrate-run.ts`](../scripts/orchestrate-run.ts) it is already
wired: when set, each node runs through `executeNodeLlm`, the flag-gated
executor in
[`servers/_orchestrate-executor.ts`](../servers/_orchestrate-executor.ts),
instead of the `bun --eval` stub subprocess.

The benchmark's real-LLM mode is **unimplemented**. The script carries a TODO
for it and `runAll` refuses to run when `ASHLR_ORCHESTRATE_REAL_LLM=1` is set,
so every report the script produces is `mode: "stub"`. Setting the flag does
not produce a real-LLM benchmark; it is an error.

## Stated timing caveat

The script's TODO and its formatted footer state that real-LLM mode will dwarf
the measured numbers because any API call is >100ms, so the orchestrator
overhead measured in stub mode only matters as a floor. The same footer prints
a fixed "~5-30ms" per-node overhead estimate and notes that parallel speedup
matches the theoretical N/maxConcurrency for wide DAGs.

Both figures are **stated commentary, not measurements**: the >100ms figure is
not a measured or guaranteed bound for any provider call, and the ~5-30ms
range is a printed constant, not output statistics. The stub timings do
include real subprocess spawn, IPC, scheduling, and best-effort persistence on
the local machine, so they are a usable local baseline, just not a universal
lower bound for the different real-LLM executor, and no evidence about
provider latency, cost, token usage, output quality, or real-agent speedup.
The script also notes the value of orchestration emerges only when each node's
work is non-trivial.
