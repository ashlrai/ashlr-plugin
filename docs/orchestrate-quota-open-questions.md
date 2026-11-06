# Orchestration: open questions for central Team quota

This is a decision list, not a description of an implemented quota or an approved policy. The executor's [Team quota TODO](../servers/_orchestrate-executor.ts#L241) says: "pass tier context and integrate central Team quota enforcement." Decisions below remain open.

For a concise integration brief, see [Orchestration Team quota: integration questions](orchestrate-quota-questions.md).

## Documented current behavior

The [current behavior note](orchestrate-quota-current-behavior.md) describes the runner limits, provider selection, per-node request and output caps, and telemetry in detail. In particular, the LLM executor receives no tier or Team identity and does not enforce a shared Team quota. The token cap is a per-call request that providers may ignore; output truncation happens after generation. Neither is a cumulative spending limit.

The [runner](../scripts/orchestrate-run.ts) retries failed nodes, and its node result records the estimate on success and zero on failure, rather than the executor's returned provider token counts. Its consent-gated, best-effort [telemetry](../scripts/orchestrate-emit-telemetry.ts) and the server's monthly [GitHub-hash rollup](../server/src/jobs/orchestrate-usage-aggregate.ts) are therefore not an authoritative Team balance. A direct executor call with an abort signal can return before the provider finishes: its provider interface does not receive that signal, so cancellation alone does not establish that generation or billing stopped. The runner's LLM dispatch currently does not pass a signal.

## Decisions needed before enforcement

1. **Identity and authority:** What authenticated Team identifier and tier entitlement should accompany each request, who verifies membership, and which service owns the authoritative balance? How should missing, revoked, or changed membership be handled? A GitHub-hash bucket is not itself a shared Team identity.
2. **Policy and units:** Is the allowance measured in graph runs, input and output tokens, cost, or a combination? What are the limits, reset period and time zone, provider/model pricing rules, and treatment of personal credentials, local providers, and usage outside orchestration?
3. **Admission and concurrency:** At what point is quota checked, and what is reserved before each provider attempt? How are simultaneous nodes, runs, and clients prevented from oversubscribing a shared balance? Should retries obtain separate reservations and should quota rejections be retried?
4. **Settlement and uncertainty:** How are reservations reconciled against actual provider usage, including usage exceeding the request, missing usage, failed calls, timeouts, and aborts that leave provider work in flight? How are duplicate requests, late responses, crashes, and expired reservations handled without double charging or silently losing usage?
5. **Availability and rollout:** If the quota service or identity lookup is unavailable, should dispatch fail closed, allow a bounded fallback, or use another policy? How will existing users migrate, and how will quota exhaustion, reset time, and recovery be presented to users?
6. **Accounting and operations:** What durable, privacy-preserving ledger and audit trail are required independently of optional telemetry? Who owns reconciliation, alerts, corrections, and disputes, and what tests demonstrate concurrency safety and recovery before enforcement is enabled?

These questions do not assert that the existing rollup or any provider supplies the needed guarantees. Resolve the policy and service contract before treating central quota as a protection against cumulative usage or cost.
