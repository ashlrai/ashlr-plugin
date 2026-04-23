---
name: ashlr-genome-keygen
description: Generate an X25519 keypair for team-cloud genome v2 encryption and register the public half with Ashlr. Run this once per machine before running /ashlr-genome-team-init. Safe to re-run — a no-op when the machine's key is already registered.
---

Run the keygen script and show the user the outcome.

Steps:

1. Run via Bash:

   ```
   bun run ${CLAUDE_PLUGIN_ROOT}/scripts/genome-keygen.ts $ARGUMENTS
   ```

2. Print the script's stdout verbatim. Do not paraphrase — the user needs to see the exact pubkey path and value on first generation.

3. If the script exits non-zero, surface its stderr:
   - Exit 2: user hasn't signed in. Suggest `/ashlr-upgrade` first.
   - Exit 3: network or server error. Suggest checking `$ASHLR_API_URL` and network.

Flags (forwarded via `$ARGUMENTS`):

| Flag | Purpose |
|---|---|
| `--force` | Regenerate even if a keypair already exists (key rotation). Previous envelopes will no longer decrypt — admins must re-wrap via `/ashlr-genome-rewrap` (lands in T4). |
| `--dry-run` | Print what would happen, no network, no file writes |
| `--endpoint <url>` | Override the default `https://api.ashlr.ai` |

## What it does

Generates a 32-byte X25519 keypair client-side. Saves both halves to `~/.ashlr/member-keys/<yourUserId>.json` with mode 0600. Uploads only the public half via `POST /user/genome-pubkey`. Your private key never leaves the machine.

## Why

Team-cloud genome v2 uses envelope encryption: admins wrap the team DEK for each member's public key; members unwrap with their private key on first pull. This replaces the v1 flow where you had to DM a 32-byte base64 string to a teammate via Signal / 1Password.
