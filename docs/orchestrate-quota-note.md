# Orchestration quota note

This note summarizes the Team-tier quota behavior of
[`servers/_orchestrate-executor.ts`](../servers/_orchestrate-executor.ts) as the
code stands today. It describes existing code, not an implemented quota or an
approved billing policy. **Central Team quota enforcement is a recorded future
follow-up, not current behavior.**

## Current Team-tier quota behavior

- **No tier context reaches the executor.** `executeNodeLlm` receives neither
  the run tier nor a Team identity. For Team, provider selection is currently
  the same as for Pro: usage is subject to the selected provider's credentials
  and any quota it enforces. The executor receives no tier context and
  does not enforce a shared Team quota.
- **Executor selection.** `executeNodeStub` — a `Bun.spawn` subprocess that
  logs `STUB-NODE` — is the production default. `executeNodeLlm` is flag-gated
  behind `ASHLR_ORCHESTRATE_REAL_LLM=1` and dispatches through the auto
  provider selector in `servers/_llm-providers/`. Both return the same
  `ExecuteNodeResult` shape.
- **Credential pre-flight.** If provider selection returns `none` (no
  Anthropic key, no Pro token, no local LLM), `executeNodeLlm` returns
  `{ ok: false, error: "no LLM credentials configured" }` without making any
  network call.
- **Per-node token request.** Each node requests
  `min(max(1, floor(estimatedTokens * 1.5)), 5000)` output tokens, with a
  missing estimate treated as zero. Providers may ignore `maxTokens`, so the
  request is not a hard bound on generation or billing.
- **Output truncation.** Output beyond four times the requested cap in
  characters (JavaScript string code units; rough chars-per-token ≈ 4) is
  truncated with `[truncated at cap]`. This happens after generation:
  reported usage is unchanged, and truncation does not limit tokens already
  generated or billed.
- **No cumulative accounting.** The per-node `maxTokens` request and output
  truncation do not track or limit cumulative usage across nodes, retries, or
  runs.
- **Retries re-request the same cap.** The
  [runner](../scripts/orchestrate-run.ts) retries a failed node up to three
  total attempts with 250 ms and 500 ms backoffs. Each attempt is an
  independent provider call with the same per-node request cap; the cap is not
  shared across attempts, and provider quota rejections are retried like any
  other failure.
- **Runner limits are scheduling limits.** Before scheduling, the runner
  rejects Free runs, Pro graphs over 3 nodes, and Team graphs over 10 nodes;
  Team concurrency defaults to 10. These are per-graph admission limits, not a
  cumulative token or spending budget. Normal tier resolution returns Pro for
  paid users and Free otherwise; the `ASHLR_TEST_TIER` override selects Team
  only for tests.
- **Accounting is estimate-based.** The runner records a successful node's
  `estimatedTokens` once and zero for a failed node, rather than the
  executor's provider-reported token counts. Consent-gated, best-effort
  telemetry and the server's monthly GitHub-hash rollup are reporting
  infrastructure, not an authoritative Team balance.
- **Cancellation does not reach the provider.** `AbortSignal` is raced against
  the provider call so callers stop waiting on abort, but the provider
  interface does not receive the signal — provider-side generation and
  billing may continue. The runner's LLM dispatch does not pass a signal. The
  stub path instead propagates the signal to `subprocess.kill()`.

## Future follow-up: central Team quota

The [`executeNodeLlm`](../servers/_orchestrate-executor.ts) docstring records
the follow-up verbatim:

> TODO: pass tier context and integrate central Team quota enforcement.

Closing it means passing tier context into the executor and integrating
central Team quota enforcement: a shared Team identity and authoritative
budget, pre-dispatch admission and reservations that survive concurrent nodes
and retries, and reconciliation of provider-reported usage including failures
and calls left in flight by aborts. Until then, per-node caps, truncation, and
telemetry do not limit cumulative Team usage or spending.

## Related notes

- [Orchestration quota: current behavior](orchestrate-quota-current-behavior.md)
  — runner-level limits and accounting in detail.
- [Orchestration quota follow-up](orchestrate-quota-follow-up.md) — the
  recorded TODO and the behavior the source states.
- [Open questions for central Team quota](orchestrate-quota-open-questions.md)
  and [integration questions](orchestrate-quota-questions.md) — the decisions
  needed before enforcement.
