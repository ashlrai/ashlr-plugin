# Orchestration quota note

This note describes how the plugin's orchestration runner ([`runTaskGraph`](../scripts/orchestrate-run.ts)) and executor ([`servers/_orchestrate-executor.ts`](../servers/_orchestrate-executor.ts)) limit work today, and what a central Team quota would still need. It describes existing code, not an implemented quota or an approved billing policy. **Central Team quota enforcement is a recorded future follow-up, not current behavior.**

## Runner tier and scheduling limits

- **Admission.** Before scheduling, the runner rejects Free runs, Pro graphs with more than 3 nodes, and Team graphs with more than 10 nodes. Default concurrency is 3 for Pro and 10 for Team; an explicit `maxConcurrency` overrides the default and is floored and clamped to at least 1. These are per-graph scheduling limits, not a cumulative token or spending budget.
- **Tier resolution.** Normal tier resolution returns Pro for paid users and Free otherwise; the `ASHLR_TEST_TIER` override can select Team, for tests. The gate uses the resolved run tier, not the graph's `tier` field. The telemetry payload takes its tier from the graph, so it is not proof of the tier that admitted the run.
- **Retries.** The runner retries a failed node up to three total attempts, with 250 ms and 500 ms backoffs, and retries provider quota rejections like any other failure. Each attempt is an independent provider call with the same per-node request cap; the cap is not shared across attempts.

## Executor behavior

- **Executor selection.** `executeNodeStub`, a `Bun.spawn` subprocess that logs `STUB-NODE`, is the production default. `executeNodeLlm` is flag-gated behind `ASHLR_ORCHESTRATE_REAL_LLM=1` and dispatches through the auto provider selector in `servers/_llm-providers/`. Both return the same `ExecuteNodeResult` shape.
- **Credential pre-flight.** If provider selection returns `none` (no Anthropic key, no Pro token, no local LLM), `executeNodeLlm` returns `{ ok: false, error: "no LLM credentials configured" }` without making any network call.
- **No tier context reaches the executor.** `executeNodeLlm` receives neither the run tier nor a Team identity. For Team, provider selection is currently the same as for Pro: usage is subject to the selected provider's credentials and any quota it enforces. The executor receives no tier context and does not enforce a shared Team quota.
- **Per-node token request.** Each node requests `min(max(1, floor(estimatedTokens * 1.5)), 5000)` output tokens, with a missing estimate treated as zero. An estimate of 10 requests 15 tokens; a missing estimate requests 1. Each call computes its cap independently, including concurrent calls. Providers may ignore `maxTokens` (the ONNX provider currently does), so the request is not a hard bound on generation or billing.
- **Output truncation.** Output longer than four times the requested cap, counted in JavaScript string code units (rough chars-per-token ≈ 4), is sliced to that length and followed by a newline and `[truncated at cap]`. Output exactly at the boundary is unchanged. This happens after generation: provider-reported usage is returned unchanged, and truncation does not limit tokens already generated or billed.
- **No cumulative accounting.** The per-node `maxTokens` request and output truncation do not track or limit cumulative usage across nodes, retries, or runs.
- **Cancellation does not reach the provider.** `AbortSignal` is raced against the provider call so callers stop waiting on abort, but the provider interface does not receive the signal, so provider-side generation and billing may continue. The runner's LLM dispatch does not pass a signal. The stub path instead propagates the signal to `subprocess.kill()`.

## Accounting

The runner records a successful node's `estimatedTokens` once, even after retries, and zero for a failed node; it does not use the executor's provider-reported token counts. With telemetry consent, it emits run usage on a best-effort basis after execution. The [payload builder](../scripts/orchestrate-emit-telemetry.ts) puts that total in `total_tokens_in` and sets `total_tokens_out` to zero, including in real-LLM mode. The server's [orchestration usage rollup](../server/src/jobs/orchestrate-usage-aggregate.ts) aggregates reported runs by GitHub hash and UTC month, excluding anonymous runs. It is reporting infrastructure, not a reservation, a shared Team quota check, or an authoritative Team balance, and it can be incomplete.

A dry run still passes the tier gate and records each node's estimate, but it invokes no provider or subprocess. It can emit the same usage telemetry: the token total is the sum of estimates, and `mode` is `real-llm` when the LLM flag is set, even though no LLM call occurred. Neither field alone establishes actual provider usage.

## Future follow-up: central Team quota

The [`executeNodeLlm`](../servers/_orchestrate-executor.ts) docstring records the follow-up verbatim:

> TODO: pass tier context and integrate central Team quota enforcement.

Closing it means passing tier context into the executor and integrating central Team quota enforcement: a shared Team identity and authoritative budget, pre-dispatch admission and reservations that survive concurrent nodes and retries, and reconciliation of provider-reported usage, including failures and calls left in flight by aborts. Until then, per-node caps, truncation, and telemetry do not limit cumulative Team usage or spending.

### Decisions needed before enforcement

This is a decision list, not an approved policy. None of these is settled, and nothing here asserts that the existing rollup or any provider supplies the needed guarantees.

1. **Identity and authority.** Which authenticated Team identifier and tier entitlement accompany each request, who verifies membership, and which service owns the authoritative balance? How are missing, revoked or changed memberships handled? A GitHub-hash bucket is not itself a shared Team identity.
2. **Policy and units.** Is the allowance measured in graph runs, input and output tokens, cost, or a combination? What are the limits, the reset period and time zone, the provider and model pricing rules, and the treatment of personal credentials, local providers, and usage outside orchestration?
3. **Admission and concurrency.** Where is each attempt authorized, and what is reserved before dispatch? How are simultaneous nodes, runs and clients kept from oversubscribing a shared balance? Do retries get separate reservations, and should quota rejections be retried?
4. **Settlement.** How are reservations reconciled against actual provider usage, including over-cap generation, missing usage, failed calls, timeouts, and aborts that leave provider work in flight? How are duplicate requests, late responses, crashes and expired reservations handled without double charging or silently losing usage?
5. **Availability and rollout.** If the quota service or identity lookup is down, does dispatch fail closed, allow a bounded fallback, or follow another policy? How do existing users migrate, and how are exhaustion, reset time and recovery shown to users?
6. **Accounting and operations.** What durable, privacy-preserving ledger and audit trail are needed independently of optional telemetry? Who owns reconciliation, alerts, corrections and disputes, and which concurrency and recovery tests must pass before enforcement is enabled?
