# Orchestration quota: current behavior

This note describes the plugin runner and [`executeNodeLlm`](../servers/_orchestrate-executor.ts), not a service-wide billing policy. **A shared, central Team usage quota is future work; the executor does not enforce one today.**

## Runner tier and scheduling limits

Before scheduling, [`runTaskGraph`](../scripts/orchestrate-run.ts) rejects Free runs, Pro graphs with more than 3 nodes, and Team graphs with more than 10 nodes. Default concurrency is 3 for Pro and 10 for Team; an explicit `maxConcurrency` overrides the default and is floored and clamped to at least 1. These are per-graph and scheduling limits, not cumulative token or spending budgets. Currently, normal tier resolution returns Pro for paid users and Free otherwise; the `ASHLR_TEST_TIER` override can select Team for tests.

The gate uses the resolved run tier, not the graph's `tier` field. The telemetry payload instead takes its tier from the graph; it should not be treated as proof of the tier used to admit the run.

The default executor is a subprocess stub. Setting `ASHLR_ORCHESTRATE_REAL_LLM=1` selects the read-only LLM executor. It receives neither tier context nor a Team identity, so Team and Pro use the same provider selection. Calls are subject to the selected provider's credentials and any limits that provider enforces, not a shared Team budget in this executor. If selection returns `none`, the executor returns `no LLM credentials configured` without calling the provider. Provider failures, including quota rejections, become node errors.

## Per-node request and output caps

For each LLM node, the requested `maxTokens` is `min(max(1, floor(estimatedTokens * 1.5)), 5000)`; a missing estimate is treated as zero. For example, an estimate of 10 requests 15 tokens, while a missing estimate requests 1. Each call computes its cap independently, including concurrent calls. This is a provider request, and a provider may ignore it (the ONNX provider currently does).

After generation, output longer than four times the requested cap is sliced to that many JavaScript string code units and followed by a newline and `[truncated at cap]`. Output exactly at the boundary is unchanged. Provider-reported input and output token counts are returned unchanged even when output is truncated. Truncation does not prevent generation or billing above the request.

The runner retries any failed node up to three total attempts, including provider quota errors, with 250 ms and 500 ms backoffs. Each attempt can call the provider again with the same per-node request cap; the cap is not shared across attempts. A direct executor call with an abort signal can return while the provider continues, since the provider interface does not receive that signal. The runner's LLM dispatch does not pass a signal. See [`runTaskGraph`](../scripts/orchestrate-run.ts) and [`executeNodeLlm`](../servers/_orchestrate-executor.ts).

## Accounting and future work

The runner records a successful node's estimate once, even after retries, and zero for a failed node; it does not use the executor's provider-reported token counts. With telemetry consent, it emits run usage on a best-effort basis after execution. The [payload builder](../scripts/orchestrate-emit-telemetry.ts) puts that total in `total_tokens_in` and sets `total_tokens_out` to zero, including in real-LLM mode. The server's [orchestration usage rollup](../server/src/jobs/orchestrate-usage-aggregate.ts) aggregates reported runs by GitHub hash and UTC month, excluding anonymous runs. It is reporting infrastructure, not a reservation or shared Team quota check; it can be incomplete and is not a Team-wide balance.

**Future work: central Team quota enforcement.** The executor's TODO is to pass tier context and integrate such enforcement. A shared Team identity and authoritative budget, pre-dispatch checks and reservations that handle concurrent calls, and reconciliation of provider usage and failures would be needed. Until then, per-node caps, truncation, and telemetry do not limit cumulative Team usage or spending.

See [open questions for central Team quota](orchestrate-quota-open-questions.md) for the decisions needed before enforcement.
