# Orchestrator benchmark scope

[`scripts/bench-orchestrate.ts`](../scripts/bench-orchestrate.ts) measures the
local wall-clock cost of `runTaskGraph` on five synthetic task graphs under
the pro and team concurrency caps. This note fixes what the measurement
covers — and the limitation the script itself states about real LLM calls.
Companion docs: [benchmark notes](orchestrate-benchmark-notes.md),
[interpretation guide](orchestrate-benchmark-interpretation.md),
[real-LLM status](orchestrate-real-llm-benchmark-status.md), and
[real-LLM note](orchestrate-real-llm-benchmark-note.md).

## In scope

Each node in every shape runs a tiny `bun --eval` stub subprocess, so a run
measures:

- per-node spawn and IPC overhead — the floor for any orchestration run,
- parallel-vs-sequential speedup against the tier concurrency cap
  (pro = 3, team = 10 total nodes),
- scheduler queue management across the five DAG shapes
  (chain-3, chain-10, wide-3, wide-10, diamond),
- best-effort result persistence under `~/.ashlr/orchestrations/`.

Per shape the report gives `wallclock_median_ms`, `wallclock_p95_ms`, and
`per_node_ms_median` (median divided by node count — a normalization, not an
individual node's time), plus `parallel_speedup_pct` on `wide-3`, which is a
multiplier despite its name. Every report carries `mode: "stub"`: the field
exists so a future real-LLM mode can label its own reports.

## Stated limitation: no real LLM calls

The script states its own limitation in the file header of
[`scripts/bench-orchestrate.ts`](../scripts/bench-orchestrate.ts): it measures
the "PURE scheduler cost" of `runTaskGraph` with "no real LLM calls". That
contract is enforced in code, not just commentary:

- `runAll` refuses to run when `ASHLR_ORCHESTRATE_REAL_LLM=1` — it throws
  "bench refuses to run with real LLM dispatch enabled" before any shape is
  measured. Setting the flag is an error, not a benchmark option.
- `BenchReport.mode` is the fixed literal `"stub"`, so no report can claim a
  real-LLM measurement.

The same header carries the TODO that bounds the numbers' meaning: real-LLM
mode "will dwarf these numbers — any API call is >100ms, so the orchestrator
overhead measured here only matters as a FLOOR", and "[t]he value of
orchestration emerges only when each node's work is non-trivial". The
formatted report repeats the caveat in its footer. The >100ms figure is the
script's stated assumption, not a measurement or a guarantee for any provider
call; the stub timings are a local reference, not a universal lower bound
for the different real-LLM executor.

The flag exists for the runner, not the bench: in
[`scripts/orchestrate-run.ts`](../scripts/orchestrate-run.ts),
`ASHLR_ORCHESTRATE_REAL_LLM=1` dispatches nodes through `executeNodeLlm`, the
flag-gated executor in
[`servers/_orchestrate-executor.ts`](../servers/_orchestrate-executor.ts).
The benchmark never exercises that path.

## Out of scope

Because no provider is ever called, the report carries no information about:

- provider or model latency, rate limits, or API failures,
- token usage, cost, or output quality,
- end-to-end speedup of real agent work.

Measuring those needs a separate experiment with representative tasks, fixed
model and provider settings, a sequential baseline, and repeated runs — see
the [interpretation guide](orchestrate-benchmark-interpretation.md) for what
such a comparison requires.
