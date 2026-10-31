# Orchestration quota notes

These notes describe the node executor in [`servers/_orchestrate-executor.ts`](../servers/_orchestrate-executor.ts), not a service-wide billing policy.

## Current behavior

The orchestration runner uses a stub by default. Setting `ASHLR_ORCHESTRATE_REAL_LLM=1` routes nodes to the read-only LLM executor. The executor receives no tier context, so Team uses the same provider selection as Pro. The selected provider's credentials and any quota that provider enforces govern the call; the executor does **not** enforce a shared Team quota or track cumulative Team usage. Provider failures are returned as node errors. When provider selection returns `none`, the executor returns `no LLM credentials configured` without calling it.

For each LLM node, the executor requests `maxTokens = min(max(1, floor(estimatedTokens * 1.5)), 5000)`, treating a missing estimate as zero. For example, an estimate of 10 requests 15 tokens; an absent estimate requests 1. This request is per node, not a budget across nodes or runs, and a provider may ignore it.

After the provider responds, output longer than four times the requested token cap is truncated to that many JavaScript string code units and followed by `[truncated at cap]`. The executor returns the provider-reported input and output token counts unchanged. Truncation happens after generation, so it does not prevent tokens from being generated or billed and is not a cumulative quota.

## Follow-up: central Team quota

The executor's documented TODO is to pass tier context and integrate central Team quota enforcement. This is future work, not a current capability. Until it is implemented, do not rely on the per-node request or output truncation to enforce a shared Team spending or usage limit.
