# Orchestration Team quota: integration questions

## Current limitation

The flag-gated [`executeNodeLlm`](../servers/_orchestrate-executor.ts) receives neither the run tier nor a Team identity. Team and Pro use the same provider selection, subject to the selected provider's credentials and any quota it enforces. The executor has no central, cumulative Team quota check or reservation. The default executor is a subprocess stub; real LLM dispatch requires `ASHLR_ORCHESTRATE_REAL_LLM=1`.

The [runner](../scripts/orchestrate-run.ts) rejects Team graphs with more than 10 nodes and defaults Team concurrency to 10. These are per-run scheduling limits, not a shared budget. Normal tier resolution currently selects Pro or Free; the Team override is for tests.

For each LLM attempt, the executor requests `min(max(1, floor(estimatedTokens * 1.5)), 5000)` output tokens, treating a missing estimate as zero. Providers may ignore that request. It truncates returned text beyond four times the requested cap in JavaScript string code units, after generation, without changing provider-reported usage. These safeguards do not bound cumulative usage or cost. Failed calls, including provider quota errors, are retried up to three total attempts by the runner.

The runner records a successful node's estimate once and zero for a failed node, rather than the executor's provider-reported usage. Consent-gated, best-effort [telemetry](../scripts/orchestrate-emit-telemetry.ts) and its [monthly GitHub-hash rollup](../server/src/jobs/orchestrate-usage-aggregate.ts) are not an authoritative Team balance. See the [current behavior note](orchestrate-quota-current-behavior.md) for details.

## Open decisions

No central quota policy or integration is established by this document.

1. **Identity and ownership:** Which authenticated Team identity and entitlement should the runner pass, who verifies membership, and which service owns the authoritative balance? How are revoked or changed memberships handled?
2. **Budget policy:** Are limits measured in input tokens, output tokens, money, runs, or a combination? What are the reset period, model/provider pricing rules, and treatment of personal credentials, local models, and usage outside orchestration?
3. **Admission:** Where is each attempt authorized and how much is reserved before dispatch? How are concurrent nodes, runs, and clients prevented from oversubscribing the same balance? Should quota rejections be retried?
4. **Settlement:** How are reservations reconciled against provider usage, especially over-cap generation, missing usage, failed calls, retries, and duplicate or late responses? What idempotency and crash-recovery guarantees are needed?
5. **Cancellation and availability:** How should in-flight work be accounted for after a timeout or abort, given that the executor's provider interface does not accept an abort signal? What happens when identity or quota services are unavailable, and how are exhaustion and reset times communicated?
6. **Operations and rollout:** What durable ledger, audit trail, reconciliation, privacy controls, and migration plan are required independently of optional telemetry? Which concurrency and recovery tests must pass before enforcement is enabled?

See also the existing [central quota decision list](orchestrate-quota-open-questions.md).
