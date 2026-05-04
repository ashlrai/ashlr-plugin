---
name: ashlr-budget
description: Set, check, or clear a session spend cap. Guards against runaway tool use in long sessions.
argument-hint: "$X | tokens=N | status | off"
---

Manage a session budget cap that blocks tool calls when the limit is reached.

## Usage

```
/ashlr-budget $X            # set USD cap (e.g. /ashlr-budget $2.00 or /ashlr-budget $0.50)
/ashlr-budget tokens=200000 # set token cap (e.g. /ashlr-budget tokens=200000)
/ashlr-budget status        # show current usage vs budget
/ashlr-budget off           # clear the budget cap
```

`$X` and `tokens=N` are mutually exclusive — setting one clears the other.

## Environment variables

The budget guard hook (`hooks/pretooluse-budget-guard.ts`) reads these env vars:

| Variable | Description |
|----------|-------------|
| `ASHLR_SESSION_BUDGET_USD` | USD cap as a decimal string (e.g. `"2.00"`) |
| `ASHLR_SESSION_BUDGET_TOKENS` | Token cap as an integer string (e.g. `"200000"`) |

The status line shows `$X / $Y · Z%` when `ASHLR_SESSION_BUDGET_USD` is set, or `Nt / Nmax · Z%` when `ASHLR_SESSION_BUDGET_TOKENS` is set.

## Steps

### `$X` — set USD cap

1. Parse the dollar amount (strip `$`, parse as float). Reject if non-positive or non-numeric.
2. Set environment variable: `ASHLR_SESSION_BUDGET_USD=<amount>` via Bash:
   ```sh
   export ASHLR_SESSION_BUDGET_USD=<amount>
   unset ASHLR_SESSION_BUDGET_TOKENS
   ```
3. Confirm: "Budget set to $`<amount>`. The pretooluse-budget-guard hook will warn at 80%, warn loudly at 95%, and block at 100%."

### `tokens=N` — set token cap

1. Parse N as integer. Reject if non-positive.
2. Set: `ASHLR_SESSION_BUDGET_TOKENS=<N>` via Bash, unset USD cap.
3. Confirm: "Budget set to `<N>` tokens."

### `status` — print current usage

1. Read `ASHLR_SESSION_BUDGET_USD` and `ASHLR_SESSION_BUDGET_TOKENS` from environment.
2. Read session-log (`~/.ashlr/session-log.jsonl`) to compute cumulative `input_size` + `output_size` bytes for the current session.
3. Estimate token usage: `tokens ≈ (input_bytes + output_bytes) / 4`.
4. Estimate USD: `usd ≈ tokens / 1_000_000 * 12` (blended $4/Mtok input + $20/Mtok output at typical 60/40 mix).
5. Print:
   ```
   Session budget status
   ─────────────────────
   USD cap:    $<cap>  (or "not set")
   Token cap:  <N>     (or "not set")
   Est. tokens used:   ~<N>
   Est. USD used:      ~$<X>
   Usage:              <Z>%
   ```
   If no budget is set: "No budget set. Use /ashlr-budget $X or /ashlr-budget tokens=N to set one."

### `off` — clear the budget cap

1. Unset both `ASHLR_SESSION_BUDGET_USD` and `ASHLR_SESSION_BUDGET_TOKENS` via Bash.
2. Confirm: "Budget cap cleared."

## Budget guard behavior (implemented in hooks/pretooluse-budget-guard.ts)

- At **80%**: emits an `additionalContext` warning: "[ashlr] Budget at 80% — $X of $Y used."
- At **95%**: emits a louder warning: "[ashlr] Budget at 95% — consider stopping soon."
- At **100%**: exits non-zero, blocking the tool call with: "[ashlr] Budget exceeded — $X cap reached. Run /ashlr-budget off to clear."
