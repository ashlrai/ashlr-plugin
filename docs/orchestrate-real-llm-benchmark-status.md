# Real-LLM orchestrator benchmark status

**TODO: real-LLM benchmark mode is not implemented.**
[`scripts/bench-orchestrate.ts`](../scripts/bench-orchestrate.ts) currently
benchmarks synthetic task graphs with stub subprocesses only. It reports
`mode: "stub"` in JSON and refuses to run when
`ASHLR_ORCHESTRATE_REAL_LLM=1`. The separate flag-gated real-LLM executor in
the orchestrator does not make this benchmark a real-LLM benchmark.

The script states that any API call is >100ms and that real-LLM latency will
dwarf the measured overhead, which it describes as a floor. This is a stated
caveat, not a measurement or guarantee for every API call. The stub timings
include subprocess startup, IPC, scheduling, and persistence; they are a local
reference, not a universal lower bound for the different real-LLM executor.
They do not measure provider latency, cost, output quality, or real-agent
speedup. The script also notes that orchestration's value emerges when each
node's work is non-trivial.

For a safe stub baseline, from the repository root with Bun and dependencies
installed, use an isolated home because the runner writes and prunes results:

```sh
bench_home=$(mktemp -d)
HOME="$bench_home" bun scripts/bench-orchestrate.ts --iterations 20 --json
```

See the [benchmark notes](orchestrate-benchmark-notes.md) for workloads and
the [interpretation guide](orchestrate-benchmark-interpretation.md) for
statistics and guidance on designing a real-workload comparison.
