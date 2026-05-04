---
name: ashlr-eco-mode
description: Toggle eco mode — aggressive token-saving behaviors that trade some response richness for lower session cost.
argument-hint: "on | off | status"
---

Toggle eco mode for the current session.

## Usage

```
/ashlr-eco-mode on      # enable eco mode
/ashlr-eco-mode off     # disable eco mode
/ashlr-eco-mode status  # show current eco mode state + active behaviors
```

## What eco mode does

When `ASHLR_ECO=1` is set, the following behaviors activate automatically:

| Behavior | Details |
|----------|---------|
| Auto-compact every 15 tool calls | Triggers `/ashlr-compact` automatically to prevent stale result accumulation |
| Force genome grep | Errors if `.ashlrcode/genome/` is missing, with a link to `/ashlr-genome-init` |
| Lower summarization threshold | Reduces LLM summarization threshold from 16384 → 12288 bytes (fires more often) |
| Smart Task routing | Task tool calls without explicit `subagent_type` are routed to `ashlr:ashlr:explore` when the prompt is question-shaped (starts with what/where/how/find/explain/why/which/when/who) |
| Suppress image attachments | Image data in tool results is stripped before processing |

## Environment variable

| Variable | Value | Effect |
|----------|-------|--------|
| `ASHLR_ECO` | `1` | Eco mode on |
| `ASHLR_ECO` | unset / `0` | Eco mode off |

The eco router hook (`hooks/pretooluse-eco-router.ts`) reads `ASHLR_ECO` and injects `subagent_type: "ashlr:ashlr:explore"` into question-shaped Task tool calls.

The status line shows a `eco` badge when `ASHLR_ECO=1`.

## Steps

### `on`

1. Set env var via Bash:
   ```sh
   export ASHLR_ECO=1
   ```
2. Print:
   ```
   Eco mode ON. Active behaviors:
   - Auto-compact every 15 tool calls
   - Force genome grep (error if .ashlrcode/genome/ missing)
   - Summarization threshold: 12288 bytes (was 16384)
   - Question-shaped Task calls routed to ashlr:ashlr:explore
   - Image attachments suppressed in tool results

   Run /ashlr-eco-mode off to disable.
   ```

### `off`

1. Unset env var via Bash:
   ```sh
   unset ASHLR_ECO
   ```
2. Print: "Eco mode OFF. All behaviors restored to defaults."

### `status`

1. Check `ASHLR_ECO` in environment.
2. If `ASHLR_ECO=1`:
   ```
   Eco mode: ON (ASHLR_ECO=1)

   Active behaviors:
   - Auto-compact every 15 tool calls              ✓
   - Force genome grep                              ✓
   - Summarization threshold: 12288 bytes           ✓ (default: 16384)
   - Question Task routing → ashlr:ashlr:explore   ✓
   - Image attachment suppression                   ✓
   ```
3. If off:
   ```
   Eco mode: OFF

   Run /ashlr-eco-mode on to enable all token-saving behaviors.
   ```

### No argument

Print the status (same as `status`).
