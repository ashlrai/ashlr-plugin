# Cloud Genome Pipeline

Architecture reference for the server-side genome build, encryption, and client pull pipeline introduced in v1.13.

---

## Overview

```
User CLI (session start)
    │
    │  hooks/session-start.ts
    │  └─ scripts/genome-cloud-pull.ts
    │       parse cwd git remote
    │       canonicalize repo URL
    │       GET /genome/personal/find?repo_url=<canon>
    │           ├─ found: download sections
    │           └─ not found: skip silently
    │       decrypt sections (user genome key)
    │       write to ~/.ashlr/genomes/<projectHash>/
    │       write .ashlr-cloud-genome marker
    │
    ▼
ashlr__grep retrieval chain
    ├─ 1. local .ashlrcode/genome/     (always wins if present)
    ├─ 2. ~/.ashlr/genomes/<hash>/     (cloud cache, via findParentGenome)
    └─ 3. ripgrep full-tree fallback
```

The cloud genome supplements local genomes — it never replaces them. If `.ashlrcode/genome/` exists in the project, it is used exclusively and the cloud cache is ignored for that session.

---

## File locations

| Path | Purpose |
|---|---|
| `~/.ashlr/genomes/<projectHash>/` | Per-project cloud genome cache directory |
| `~/.ashlr/genomes/<projectHash>/.ashlr-cloud-genome` | Marker file; presence indicates a cloud genome is loaded |
| `~/.ashlr/genome-key` | Per-user master genome decryption key, mode `0o600`. Fetched once from `GET /user/genome-key` and cached locally. |
| `~/.ashlr/genome-cloud-pull.log` | Pull log: timestamps, section counts, errors |

`<projectHash>` is a SHA-256 of the canonical repo URL (e.g. `github.com/owner/repo`), truncated to 16 hex chars.

---

## Build pipeline

Source: `server/src/services/genome-build.ts`

```
POST /genome/build  { userId, owner, repo }
    │
    ▼
buildGenomeFromGitHub(userId, owner, repo)
    │
    ├─ tier check: free tier → visibility must be "public"
    │    live check via api.github.com/repos/<owner>/<repo>
    │    (server-enforced; client cannot bypass)
    │
    ├─ git clone --depth 1  (60s timeout)
    │
    ├─ bun run scripts/genome-init.ts --minimal  (120s timeout)
    │    produces: architecture.md, conventions.md, decisions.md
    │    + top-level file index
    │
    ├─ per-section AES-GCM encrypt
    │    key: users.genome_encryption_key_encrypted (auto-generated on first build)
    │
    └─ upsertSection → genomes table
         sets build_status = "ready", last_built_at = now()
```

Rate limit: 5 builds per user per hour (`POST /genome/build`).

---

## Tier gating

| Tier | Repo visibility | Enforcement |
|---|---|---|
| Free | Public repos only | Server performs live `api.github.com` check on every build request. `repo_visibility` stored in `genomes` table for audit. |
| Pro | Public + private | `repo` scope step-up consent required. Server verifies token has `repo` scope before cloning. |

The client cannot fake visibility. The live API check is performed server-side regardless of what the client reports.

---

## Encryption

### Per-user genome key

Each user has a `genome_encryption_key_encrypted` column in the `users` table. This is a random 32-byte key, itself encrypted with the server's `ASHLR_MASTER_KEY`. The key is auto-generated on first private-repo build (or first genome build for Pro users).

`GET /user/genome-key` returns the decrypted key over TLS. The client caches it at `~/.ashlr/genome-key` with mode `0o600`. This file is never included in git history or synced.

### Section encryption

Each genome section is encrypted individually with AES-256-GCM:
- Random 12-byte IV per section
- Auth tag appended
- Implementation: `servers/_genome-crypto.ts`

The server stores ciphertext; plaintext never touches disk on the server after the build completes.

---

## Webhook-driven delta rebuild

Source: `server/src/routes/webhooks.ts`

GitHub push events trigger incremental re-indexing of affected genome sections rather than a full rebuild.

```
GitHub push event → POST /webhooks/github
    │
    ├─ verify HMAC-SHA256 signature (timingSafeEqual)
    │    header: X-Hub-Signature-256
    │    secret: GITHUB_WEBHOOK_SECRET
    │
    ├─ deduplicate by X-GitHub-Delivery header (idempotency)
    │
    ├─ extract changed file paths from commits[].added/modified/removed
    │
    ├─ map paths → genome sections (by path prefix)
    │
    └─ re-run genome-init --section <name> for each affected section
         upsertSection → update last_built_at
```

Signature verification is at `server/src/routes/webhooks.ts:28-35`. Deliveries are stored by delivery ID; a duplicate delivery is acknowledged with 200 and skipped.

To register the webhook on your repo: `github.com/<owner>/<repo>/settings/hooks` → Payload URL: `https://api.plugin.ashlr.ai/webhooks/github`, content type: `application/json`, events: `push`.

---

## Kill switch

Set `ASHLR_CLOUD_GENOME_DISABLE=1` in your shell environment (or in `~/.claude/settings.json` under `env`) to disable the cloud genome pull entirely. `ashlr__grep` will skip the `~/.ashlr/genomes/` cache and fall through to ripgrep.

This is useful if you are on a slow connection, working offline, or want to force the local-only code path for testing.

---

## When `ashlr__grep` consults the cloud cache

The retrieval order in `servers/_genome-cache.ts:findParentGenome`:

1. Walk up from `cwd` looking for `.ashlrcode/genome/`. If found, use it — done.
2. Compute `projectHash` from the git remote of `cwd`.
3. Check `~/.ashlr/genomes/<projectHash>/.ashlr-cloud-genome` exists.
4. If yes, load sections from that directory and run TF-IDF retrieval.
5. If no match or `ASHLR_CLOUD_GENOME_DISABLE=1`, fall through to ripgrep.

The local genome always wins. Cloud is a supplement, not a replacement.
