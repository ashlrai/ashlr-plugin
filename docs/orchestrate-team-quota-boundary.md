# Orchestration Team quota boundary

This describes the current plugin runner and [`executeNodeLlm`](../servers/_orchestrate-executor.ts), not a service-wide billing policy.

## What is enforced today

- The runner gates Free, Pro, and Team before scheduling. Its resolved Team tier allows at most 10 nodes in a graph and defaults to 10 concurrent nodes; Pro allows 3. These are graph and scheduling limits, not usage budgets across runs. The runner currently resolves paid users as Pro unless the test tier override is used. See [`orchestrate-run.ts`](../scripts/orchestrate-run.ts).
- The default executor is a subprocess stub. `ASHLR_ORCHESTRATE_REAL_LLM=1` selects the read-only LLM executor. It receives no tier or Team identity, so Team and Pro use the same provider selection. The selected provider's credentials and any limits it enforces govern the call. For example, the cloud service has its own per-token request rate limit and per-user daily cap; these are not a shared Team quota.
- If selection returns `none`, the executor returns `no LLM credentials configured` without calling the provider. Provider errors, including quota rejections, become node errors.

For each LLM node, the executor requests `maxTokens = min(max(1, floor(estimatedTokens * 1.5)), 5000)`, treating a missing estimate as zero. An estimate of 10 requests 15; an absent estimate requests 1. This is an independent request for each call, not a cumulative budget. A provider may ignore it (the ONNX provider currently does).

After generation, output longer than four times the requested cap is truncated to that many JavaScript string code units and followed by `[truncated at cap]`. Provider-reported input and output token counts are returned unchanged, even when output is truncated. This does not prevent generation or billing above the request.

## Accounting is not enforcement

With telemetry consent, the runner emits run usage on a best-effort basis after execution. The server's [`orchestration usage rollup`](../server/src/jobs/orchestrate-usage-aggregate.ts) aggregates reported runs by GitHub hash and UTC month, excluding anonymous runs. It is reporting infrastructure, not a reservation or a shared Team quota check in this executor; it can be incomplete and is not a Team-wide balance.

## Follow-up: central Team quota

The executor's TODO is to pass tier context and integrate central Team quota enforcement. That work must establish a shared Team identity and authoritative usage budget, check and reserve capacity before dispatch (including concurrent calls), and reconcile actual provider usage and failures. Until such enforcement exists, do not rely on node caps, truncation, or telemetry to limit cumulative Team usage or spending.
