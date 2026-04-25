---
name: ashlr-genome-rewrap
description: Re-wrap the team-cloud genome DEK for every member with a current pubkey. Run this after a teammate rotates their keypair (/ashlr-genome-keygen --force) or joins the team and runs /ashlr-genome-keygen for the first time. Admin-only.
argument-hint: "[--rotate-dek] [--endpoint <url>]"
---

Run the rewrap script and show the user its output verbatim.

Steps:

1. Run via Bash:

   ```sh
   bun run ${CLAUDE_PLUGIN_ROOT}/scripts/genome-rewrap.ts $ARGUMENTS
   ```

2. Print the script's stdout verbatim — the per-member wrap log is what
   the admin needs to confirm success.

3. If the script exits non-zero, surface its stderr:
   - Exit 2: prereq missing — likely no Pro token, no local keypair, or
     no `.cloud-id` in this repo. Suggest the relevant skill:
     `/ashlr-upgrade`, `/ashlr-genome-keygen`, or `/ashlr-genome-team-init`.
   - Exit 3: network / server error. Suggest checking `$ASHLR_API_URL`
     and the team's tier (rewrap requires Team tier).

Flags (forwarded via `$ARGUMENTS`):

| Flag | Purpose |
|---|---|
| `--rotate-dek` | Generate a fresh team DEK before wrapping. Invalidates every existing envelope. Use after a suspected key compromise. |
| `--endpoint <url>` | Override the default `https://api.ashlr.ai` |
| `--cwd <dir>` | Repo to operate on (default cwd) |

## When to use

- A teammate ran `/ashlr-genome-keygen --force` (rotated their key); their
  previous envelope no longer decrypts.
- A new teammate joined the team and ran `/ashlr-genome-keygen`; they now
  have a pubkey on file but no envelope yet.
- Suspected key compromise — run with `--rotate-dek` to mint a fresh DEK
  and invalidate every prior envelope at once.

## What it does

Re-wraps the existing team DEK for every member with a current pubkey on
file. With `--rotate-dek`, generates a fresh DEK first so every old
envelope is invalidated.
