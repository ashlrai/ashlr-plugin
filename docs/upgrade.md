# ashlr upgrade — terminal-native free-to-pro flow

Run `/ashlr-upgrade` inside Claude Code to go from free to Pro or Team in
under 90 seconds without leaving the terminal.

## Quick start

```
/ashlr-upgrade
```

That's it. The flow handles sign-in, plan selection, Stripe checkout, and
activation confirmation automatically.

## What happens step by step

```
  ╔══════════════════════════════════╗
  ║      ashlr  ·  upgrade           ║
  ╚══════════════════════════════════╝

▬▬▬ STEP 1/5: Checking current tier ▬▬▬
  ✓  Not signed in yet.

▬▬▬ STEP 2/5: Sign in ▬▬▬
  No active Pro token found. Let's sign you in first.
  [ASHLR_PROMPT: Email to sign in?] you@example.com
  ✓  Magic link sent to you@example.com. Check your inbox — click the link to continue.
     Waiting for you to click the link (up to 3 minutes)...
  Waiting ...
  ✓  Sign-in confirmed.
  ✓  Token saved to ~/.ashlr/pro-token and ~/.ashlr/env (auto-loaded on next session).

▬▬▬ STEP 3/5: Choose your plan ▬▬▬

  1)  Pro  ·  $12/mo  [default]
  2)  Pro  ·  $120/yr  (save 17%)
  3)  Team ·  $24/user/mo
  4)  Team ·  $240/user/yr  (save 17%)

  [ASHLR_PROMPT: Choose a plan (1-4, default 1):] 1
  ✓  Selected: Pro  ·  $12/mo

▬▬▬ STEP 4/5: Open Stripe checkout ▬▬▬
  ✓  Opened checkout in your browser. Complete payment to activate Pro.

▬▬▬ STEP 5/5: Waiting for payment confirmation ▬▬▬
     Polling for payment confirmation (up to 10 minutes)...
  Waiting ...

  ashlr Pro is now active.
  Your API token is saved locally. All Pro features are unlocked.

  What just changed:
  - Hosted LLM summarizer — Ollama not required
  - Cross-machine stats sync
  - Leaderboard participation
  - Priority support at support@ashlr.ai

  Next: run /ashlr-dashboard to see your usage.
```

## Already on Pro

If `ASHLR_PRO_TOKEN` is set and your account is already Pro or Team, the
flow exits immediately:

```
▬▬▬ STEP 1/5: Checking current tier ▬▬▬
  ✓  You're already on Pro.
     Run /ashlr-dashboard to see usage.
```

## Flags

| Flag | Effect |
|------|--------|
| `--tier pro\|team` | Pre-select tier, skip the plan prompt |
| `--annual` | Pre-select annual billing |
| `--email <addr>` | Pre-supply email, skip the email prompt |
| `--no-poll` | Skip the activation polling step (useful for testing or CI) |

Example — skip all interactive prompts:

```
/ashlr-upgrade --tier pro --annual --email you@example.com
```

## Headless / SSH sessions (no browser)

Set `ASHLR_NO_BROWSER=1` to suppress the automatic browser open. The
checkout URL is printed to the terminal instead:

```sh
ASHLR_NO_BROWSER=1
```

Then copy the printed URL and open it in a browser on any device.

## If the browser fails to open

If `open` / `xdg-open` / `start` is not available (remote server, Docker,
minimal Linux), the flow falls back gracefully:

```
  !  Could not open a browser automatically.

  Open this URL manually:

  https://checkout.stripe.com/c/pay/cs_live_...
```

The activation poller continues running. Complete payment in your browser and
the terminal will detect it automatically.

## Manually pasting a token

If you already have an API token (from the web dashboard at
plugin.ashlr.ai), you can skip the magic-link flow entirely:

1. Save the token: `echo "export ASHLR_PRO_TOKEN=<token>" >> ~/.ashlr/env`
2. Source it: `source ~/.ashlr/env`
3. Verify: `/ashlr-upgrade` will see your Pro status and exit immediately.

## What happens if the poll times out

After you open checkout, the script polls `/billing/status` every 5 seconds
for up to 10 minutes. If payment isn't detected within that window, you'll see:

```
  !  Haven't detected payment yet.
     Once you complete checkout, run /ashlr-upgrade again to verify and activate.
```

Run `/ashlr-upgrade` again after completing payment — step 1 will detect the
new tier and exit immediately.

## Token storage

After sign-in the API token is saved in two places:

| File | Purpose |
|------|---------|
| `~/.ashlr/pro-token` | Raw token (mode 0600) |
| `~/.ashlr/env` | `export ASHLR_PRO_TOKEN=<token>` — sourced by the SessionStart hook |

The SessionStart hook reads `~/.ashlr/env` on every new Claude Code session,
so `ASHLR_PRO_TOKEN` is available automatically without a shell restart.

## Pro features unlocked

| Feature | Free | Pro |
|---------|------|-----|
| Hosted LLM summarizer | No (local Ollama required) | Yes |
| Cross-machine stats sync | No | Yes |
| Leaderboard | No | Yes |
| Priority support | No | Yes (support@ashlr.ai) |

See [billing.md](billing.md) for full tier comparison and lifecycle details.
