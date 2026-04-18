---
name: ashlr-upgrade
description: >
  Terminal-native free-to-pro upgrade for ashlr. Walks the user from free
  to Pro or Team in under 90 seconds without leaving the terminal. Handles
  sign-in via magic link, plan selection, Stripe checkout, and activation
  polling — all from the CLI.
---

You are running the ashlr upgrade flow.

## Invocation

Run the upgrade script:

```sh
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-flow.ts"
```

Stream its stdout verbatim to the user. Do not add narration between steps —
the script output is the narrative.

## Flags

Pass any user-supplied flags through directly. Supported flags:

- `--tier pro|team` — pre-select a tier
- `--annual` — pre-select annual billing
- `--email <addr>` — skip the email prompt
- `--no-poll` — skip the activation polling step (useful for testing)

Example with flags:

```sh
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-flow.ts" --tier pro --annual
```

## Handling [ASHLR_PROMPT: ...] markers

When the script prints a line starting with `[ASHLR_PROMPT: ...]`, pause,
ask the user exactly the question inside the brackets, collect their input,
and write it to the script's stdin followed by a newline.

The markers you will encounter:

- `[ASHLR_PROMPT: Email to sign in?]` — ask for the user's email address
- `[ASHLR_PROMPT: Choose a plan (1-4, default 1):]` — ask which plan number
- `[ASHLR_PROMPT: How many seats (default 3):]` — (Team plans only) ask seat count

## Error handling

If the script exits non-zero, show stderr and tell the user to run
`/ashlr-doctor` for a full diagnosis.

## Rules

- Do not run any destructive operation without the user's explicit confirmation.
- Do not add narration between wizard sections — the script output is the narrative.
- Keep responses concise — the upgrade flow output is the substance.
- If the user is already on Pro or Team, the script will say so and exit — do not re-run it.
