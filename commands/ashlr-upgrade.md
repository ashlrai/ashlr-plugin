---
name: ashlr-upgrade
description: >
  Terminal-native free-to-pro upgrade for ashlr. Walks the user from free
  to Pro or Team in under 90 seconds without leaving the terminal. Primary
  path: GitHub OAuth sign-in. Fallback: magic-link email. Handles plan
  selection, Stripe checkout (with 7-day Pro trial on first checkout), and
  activation polling — all from the CLI.
---

You are running the ashlr upgrade flow.

## What Pro gives you

Five things Free cannot do without cloud infrastructure:

- **Cross-machine stats sync** — your per-session token ledger syncs across machines so `/ashlr-savings` and `/ashlr-dashboard` show your real lifetime history, not just the current machine.
- **Cloud LLM summarizer** — genome summarization and `ashlr__read` LLM passes run on hosted infrastructure. No local Ollama or GPU required; the free tier falls back to ONNX/snip-compactor.
- **Hosted embedding retrieval** — `ashlr__grep` uses a cloud pgvector index refreshed on every push. Material quality improvement on repos with > 5,000 files vs local TF-IDF.
- **Live auto-updating badge** — the `/ashlr-badge` SVG URL updates automatically. Embed it in your README and it always reflects current savings.
- **Leaderboard + priority support** — opt-in savings percentile comparison, one-business-day support response.

Price: **$12/mo** or **$120/yr**. First checkout includes a **7-day free trial** — no charge until the trial ends, cancel any time. The free tier is never crippled; Pro adds cloud, it does not remove anything free.

## Invocation

Run the upgrade script:

```sh
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-flow.ts"
```

Stream its stdout verbatim to the user. Do not add narration between steps —
the script output is the narrative.

## Sign-in methods

The script will first ask how the user wants to sign in:

1. **Sign in with GitHub** (primary) — opens `https://plugin.ashlr.ai/signin`
   in the browser. After GitHub OAuth consent (`read:user user:email public_repo`),
   the CLI receives a token automatically. This also unlocks the repo picker for
   auto-genome builds on public repos.
2. **Magic link** (fallback) — sends a one-time sign-in link to the user's email.
   Use this if the user cannot open a browser or prefers not to connect GitHub.

## Flags

Pass any user-supplied flags through directly. Supported flags:

- `--tier pro|team` — pre-select a tier
- `--annual` — pre-select annual billing
- `--email <addr>` — skip the email prompt (magic-link path only)
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

- `[ASHLR_PROMPT: How would you like to sign in? (1) GitHub  (2) Email magic link]` — ask which method
- `[ASHLR_PROMPT: Email to sign in?]` — ask for the user's email address (magic-link path)
- `[ASHLR_PROMPT: Choose a plan (1-4, default 1):]` — ask which plan number
- `[ASHLR_PROMPT: How many seats (default 3):]` — (Team plans only) ask seat count

## 7-day Pro trial

First-time Pro checkouts include a 7-day free trial — no charge until the
trial ends. The script surfaces the trial offer automatically. If you see a
user hesitating, remind them: trial starts immediately, cancel any time before
day 7, no charge if cancelled.

## Error handling

If the script exits non-zero, show stderr and tell the user to run
`/ashlr-doctor` for a full diagnosis.

## Rules

- Do not run any destructive operation without the user's explicit confirmation.
- Do not add narration between wizard sections — the script output is the narrative.
- Keep responses concise — the upgrade flow output is the substance.
- If the user is already on Pro or Team, the script will say so and exit — do not re-run it.
