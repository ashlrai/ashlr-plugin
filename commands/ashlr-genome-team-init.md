---
name: ashlr-genome-team-init
description: Initialize (or rewrap for new members of) a team-cloud genome for the current repo. One-time per repo by an admin; then teammates join via /ashlr-team-invite + /ashlr-genome-keygen + admin re-runs with --wrap-all.
---

Run the team-init script and show the user the outcome.

Steps:

1. Run via Bash:

   ```
   bun run ${CLAUDE_PLUGIN_ROOT}/scripts/genome-team-init.ts $ARGUMENTS
   ```

2. Print the script's stdout verbatim. Don't paraphrase — the user needs to see the `genomeId` and `.cloud-id` path to understand what to commit.

3. If the script exits non-zero, surface its stderr:
   - Exit 2: prereq missing. Most common: `/ashlr-upgrade` (no pro-token), `/ashlr-genome-keygen` (no local member keypair), team-tier not reached, no git remote.
   - Exit 3: network / server error.

Flags (forwarded via `$ARGUMENTS`):

| Flag | Purpose |
|---|---|
| `--force` | Reinitialize even if `.cloud-id` already exists. **This rotates the DEK** — existing team envelopes stop working until re-wrapped. |
| `--wrap-all` | Skip init; just mint envelopes for every team member with a pubkey on file. Use after adding a teammate (`/ashlr-team-invite` + they run `/ashlr-genome-keygen`). |
| `--endpoint <url>` | Override the default `https://api.ashlr.ai` |
| `--cwd <dir>` | Use a different repo root |

## What it does (fresh init)

1. Resolves the repo URL from `git remote get-url origin`.
2. `POST /genome/init` — server allocates a new `genomeId` scoped to your team.
3. Generates a fresh 32-byte DEK client-side.
4. Wraps the DEK for your own X25519 pubkey (via T2's `wrapDek`).
5. `POST /genome/:id/key-envelope` — uploads the self-wrapped envelope so your push path immediately works.
6. Writes `.ashlrcode/genome/.cloud-id` so subsequent pushes (and SessionStart pulls, T5) find the genome.

Commit `.ashlrcode/genome/.cloud-id` to the repo so teammates auto-discover the cloud genome on checkout.

## What it does (--wrap-all)

1. Reads `.cloud-id`, fetches your own envelope, unwraps to recover the team DEK.
2. Lists all team members + their registered pubkeys (via `GET /genome/:id/members`).
3. For each member with a pubkey, wraps the DEK and uploads the envelope.
4. Reports who got wrapped and who was skipped (no pubkey yet — they need to run `/ashlr-genome-keygen`).

## Typical team setup

```
# on admin's machine
/ashlr-upgrade                            # get pro-token (team tier)
/ashlr-genome-keygen                      # generate X25519 keypair
/ashlr-genome-team-init                   # bootstrap genome, self-wrap
git add .ashlrcode/genome/.cloud-id && git commit -m "chore: team genome" && git push

# on each teammate's machine
/ashlr-upgrade                            # same (or accept invite first)
/ashlr-genome-keygen                      # generate their X25519 keypair
# wait for admin...

# back on admin's machine
/ashlr-genome-team-init --wrap-all        # mint envelopes for the new pubkeys

# teammate pulls, next /ashlr-genome-push works
```
