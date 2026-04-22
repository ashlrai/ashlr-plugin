# GitHub OAuth Onboarding

Complete walkthrough: sign in with GitHub, pick a repo, and have a cloud genome ready before your first grep.

---

## Prerequisites

- ashlr-plugin installed and active (`/ashlr-status` shows green)
- Claude Code running (any plan)
- A GitHub account with at least one public repo

---

## Step 1 — Start the upgrade flow

Inside Claude Code, run:

```
/ashlr-upgrade
```

The script will ask how you want to sign in. Choose option 1: **Sign in with GitHub**.

Alternatively, visit `https://plugin.ashlr.ai/signin` directly in your browser.

---

## Step 2 — Click "Sign in with GitHub"

Your browser opens `https://plugin.ashlr.ai/signin`. Click the "Sign in with GitHub" button. You will be redirected to GitHub's OAuth consent screen.

---

## Step 3 — Authorize the GitHub scopes

GitHub will ask you to authorize three scopes:

| Scope | Why it's needed |
|---|---|
| `read:user` | Read your GitHub username and profile |
| `user:email` | Read your primary email address for account creation |
| `public_repo` | List your public repos in the repo picker; clone public repos for genome builds |

Click **Authorize**. These are the minimum scopes required. Private-repo access (`repo` scope) is a separate step-up consent — it is never requested without an explicit prompt.

---

## Step 4 — CLI receives token automatically

After you authorize, GitHub redirects back to `plugin.ashlr.ai/auth/github/callback`. The server:

1. Exchanges the code for a GitHub access token.
2. Encrypts the token with AES-256-GCM and stores it server-side.
3. Writes a session record that your CLI is polling.

Your terminal (which has been polling `/auth/status?session=<sid>` in the background) will print a confirmation and continue to the next step automatically. You do not need to copy or paste anything.

---

## Step 5 — Pick a public repo in the repo picker

Your browser lands on the repo picker at `plugin.ashlr.ai/repos`. It shows your public GitHub repos. Click a repo to trigger a genome build.

The genome build runs in the background on the server:

- `git clone --depth 1` of the repo (60s timeout)
- `genome-init --minimal` to extract architecture, conventions, and key paths (120s timeout)
- Sections are encrypted per-user with AES-GCM and stored

Small repos (< 1k files): 5–10 seconds. Large repos: up to 2 minutes. You can close the browser tab — the build continues server-side.

---

## Step 6 — Cloud genome is consulted automatically

On your next session start in a project whose git remote matches the repo you picked, `hooks/session-start.ts` runs `scripts/genome-cloud-pull.ts` which:

1. Reads the git remote of your current `cwd`.
2. Canonicalizes the repo URL and calls `GET /genome/personal/find?repo_url=<canon>`.
3. Downloads encrypted sections to `~/.ashlr/genomes/<projectHash>/`.
4. Writes a `.ashlr-cloud-genome` marker file.

From that point on, `ashlr__grep` checks the cloud genome cache automatically — no flags, no config. Local `.ashlrcode/genome/` always takes precedence if it exists.

---

## Troubleshooting

### Token not saved / CLI not receiving the callback

- Make sure the browser tab stayed open through the OAuth flow.
- Check that `BASE_URL` on the server matches the URL your CLI is hitting.
- Run `/ashlr-doctor` — it checks auth connectivity.
- Try `/ashlr-upgrade` again; the polling session is single-use but a new one is issued each run.

### Genome build failed

- Check build status at `plugin.ashlr.ai/repos` — each repo shows a status badge.
- Common causes: repo too large (> 50k files), clone timeout, missing default branch.
- Open an issue with the repo URL (public repos only) at `github.com/ashlrai/ashlr-plugin`.

### Private repo access

Private repos require the Pro tier. After upgrading, `/ashlr-upgrade` will offer a `repo` scope step-up consent screen. This is a separate OAuth authorization — you will see a new GitHub consent page listing the additional `repo` scope. See [docs/cloud-genome.md](cloud-genome.md) for how tier gating works server-side.

### Revoking access

To revoke ashlr's GitHub access: visit `github.com/settings/applications`, find "ashlr", click Revoke. Your stored token will be invalidated on GitHub's side; the encrypted copy on the server will fail to authenticate on next use and be cleared.

---

## Security note

GitHub access tokens are encrypted at rest using AES-256-GCM with a server-managed master key (`ASHLR_MASTER_KEY`). Tokens are never returned to the browser. OAuth state tokens are HMAC-signed with a 10-minute TTL and use constant-time comparison to prevent timing attacks. Scopes are limited to the minimum required; `repo` (private access) requires explicit additional consent.

See [SECURITY.md](../SECURITY.md#github-oauth-security-v113) for the full security model.

---

## Kill switches

| Method | Effect |
|---|---|
| `ASHLR_CLOUD_GENOME_DISABLE=1` | Disables cloud genome pull on session start. `ashlr__grep` will not consult `~/.ashlr/genomes/`. |
| Delete `~/.ashlr/genomes/` | Removes all locally cached cloud genome sections. They will re-download on next session start if the server still has a build. |
| Revoke on GitHub | Invalidates the access token. Genome builds for private repos will fail until re-authorized. |
