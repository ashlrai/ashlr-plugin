# Orchestration Team quota follow-up

## Current fallback

The default runner uses the subprocess stub. The read-only LLM executor is
enabled by `ASHLR_ORCHESTRATE_REAL_LLM=1`. For Team, its fallback is the same
provider selection as Pro: the selected provider's credentials and any quota
it enforces apply. The executor receives no tier context and does not enforce a
shared Team quota. If selection returns `none`, it returns
`no LLM credentials configured` without calling the provider; provider errors,
including quota errors, become node errors.

Each LLM attempt requests `min(max(1, floor(estimatedTokens * 1.5)), 5000)`
output tokens, with a missing estimate treated as zero. Providers may ignore
that request. After generation, output exceeding four times the requested cap
in JavaScript string code units is truncated with `[truncated at cap]`;
provider-reported usage remains unchanged. Neither safeguard tracks or limits
cumulative Team usage or prevents generation or billing beyond the request.
See [`executeNodeLlm`](../servers/_orchestrate-executor.ts) and the
[current behavior note](orchestrate-quota-current-behavior.md).

## Follow-up, not implemented

The executor's TODO is to **pass tier context and integrate central Team quota
enforcement**. The policy and integration remain open: a shared Team identity
and authoritative budget, admission and reservations across concurrent
attempts, and reconciliation of provider usage and failures need decisions.
Retries and in-flight calls that continue after an abort also need accounting.
The existing per-node caps and telemetry are not a central quota. See the
[integration questions](orchestrate-quota-questions.md) for decisions and
[open questions](orchestrate-quota-open-questions.md) for further detail.
