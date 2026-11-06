# Orchestration quota follow-up

This note records the Team-tier central-quota TODO in
[`servers/_orchestrate-executor.ts`](../servers/_orchestrate-executor.ts) and the
current behavior that file states. It describes existing code, not an
implemented quota or an approved policy.

## The recorded TODO

The [`executeNodeLlm`](../servers/_orchestrate-executor.ts) docstring ends with,
verbatim:

> TODO: pass tier context and integrate central Team quota enforcement.

Until that follow-up lands, no shared Team quota exists anywhere in the
executor.

## Current behavior stated in the source

- **Executor selection.** `executeNodeStub` (a `Bun.spawn` subprocess that logs
  `STUB-NODE`) is the production default. `executeNodeLlm` is flag-gated behind
  `ASHLR_ORCHESTRATE_REAL_LLM=1` and dispatches through the auto provider
  selector in `servers/_llm-providers/`. Both return the same
  `ExecuteNodeResult` shape.
- **Credential pre-flight.** If provider selection returns `none` (no Anthropic
  key, no Pro token, no local LLM), `executeNodeLlm` returns
  `{ ok: false, error: "no LLM credentials configured" }` without making any
  network call.
- **Team tier.** For Team, provider selection is currently the same as for Pro:
  usage is subject to the selected provider's credentials and any quota it
  enforces. The executor receives no tier context and does not enforce a shared
  Team quota.
- **Per-node token request.** Each node requests
  `min(max(1, floor(estimatedTokens * 1.5)), 5000)` output tokens, with a
  missing estimate treated as zero. This is a request to the provider, and
  provider implementations may ignore `maxTokens`.
- **Output truncation.** Output beyond four times the requested cap in
  characters (rough chars-per-token ≈ 4) is truncated with
  `[truncated at cap]`. Reported usage is not reduced; truncation does not
  limit tokens already generated or billed.
- **No cumulative accounting.** The per-node `maxTokens` request and output
  truncation do not track or limit cumulative usage across nodes, retries, or
  runs.
- **Cancellation.** `AbortSignal` is raced against the provider call so callers
  stop waiting on abort; the provider interface itself does not receive the
  signal, so generation (and billing) may continue server-side. The stub path
  instead propagates the signal to `subprocess.kill()`.

## Follow-up, not implemented

Closing the TODO means passing tier context into the executor and integrating
central Team quota enforcement: a shared Team identity and authoritative
budget, pre-dispatch admission and reservations that survive concurrent nodes
and retries, and reconciliation of provider-reported usage including failures
and calls left in flight by aborts. The existing per-node caps, truncation,
and telemetry are not a central quota.

See [current behavior](orchestrate-quota-current-behavior.md) for runner-level
limits and accounting, and the
[integration questions](orchestrate-quota-questions.md) and
[open questions](orchestrate-quota-open-questions.md) for the decisions needed
before enforcement.
