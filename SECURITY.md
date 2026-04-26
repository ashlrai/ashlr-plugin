# Security Policy

## Reporting

If you've found a vulnerability in ashlr-plugin or `@ashlr/core-efficiency`, please email **security@ashlr.ai** with details. Do not open a public GitHub issue for vulnerabilities.

Expect a reply within 72 hours.

## Scope

In scope:
- The MCP server (`servers/efficiency-server.ts`) — path traversal, unsafe shell invocation, code execution via crafted arguments, stats-file poisoning
- The shared `@ashlr/core-efficiency` library — the same categories, plus crafted genome manifests that could escape the genome directory
- The agent definitions in `agents/*.md` — prompt-injection shapes that would cause the agent to take actions against the user's interest

Not in scope:
- Claude Code itself (report to Anthropic)
- The GitHub Pages hosting layer (report to GitHub)
- The dependencies we pull from npm — if it's in `node_modules`, start with the upstream project. We'll coordinate if it affects ashlr directly.

## Defaults

- The MCP server binds to stdio only — no network socket is opened.
- Savings stats are written to `~/.ashlr/stats.json` with user-readable permissions (no secrets stored).
- **Free tier**: no telemetry, no phone-home, no analytics beacon. All LLM
  summarization is local-only (LM Studio / Ollama on `http://localhost:1234/v1`
  by default; override with `ASHLR_LLM_URL`).
- **Pro tier**: the hosted cloud summarizer and the audit-upload hook are
  **off by default**. Pro users opt each in explicitly:
  - `ASHLR_PRO_ENABLE_CLOUD_LLM=1` — route large-tool summarization to
    `https://api.ashlr.ai/llm`. The payload is the same text your local LLM
    would have seen (file content for `ashlr__read`, shell output for
    `ashlr__bash`, HTTP response body for `ashlr__http`, etc).
  - `ASHLR_PRO_ENABLE_AUDIT=1` — enable the `PostToolUse` audit-upload hook.
    By default only shapes (tool name, path, byte counts, git commit) are sent
    to `/audit/event`; set `ASHLR_PRO_AUDIT_FULL=1` to include raw tool
    arguments (file contents, Bash commands, edit diffs). Full-fidelity mode
    is strictly opt-in per session.
  Neither variable is set by `/ashlr-upgrade`; users who want them turn them
  on in `~/.ashlr/env` (see note below on `sourceAshlrEnv` allow-list).

## Trust model

ashlr-plugin's MCP tools run inside the user's Claude Code session with whatever filesystem,
shell, and network privileges the host shell has. The calling model (Claude) can be
prompt-injected by third-party content — file contents it reads, tool output it summarizes, web
pages it fetches. Tool input is therefore treated as untrusted even though it arrives through the
same process that runs the user's commands. The boundaries below are the ones currently enforced;
new code should preserve them.

### Filesystem scope — `process.cwd()` clamp

Every filesystem-touching MCP tool clamps caller-supplied paths to `process.cwd()` and its
descendants. A path that resolves outside the working directory is refused with a message like:

```
ashlr__tree: refused path outside working directory: /etc
(cwd is /Users/alice/project)
```

Without this clamp, a prompt-injected call like `tree path="/"` or `grep cwd="/etc"` would
exfiltrate the host's filesystem layout. The shared helper at `servers/_cwd-clamp.ts` applies the
check and resolves symlinks via `realpathSync` so `/var/folders/…` and `/private/var/folders/…`
(macOS) are treated as the same directory. Any new FS-touching tool under `servers/` should route
its path argument through `clampToCwd()`.

Tools currently clamped: `ashlr__ls`, `ashlr__glob`, `ashlr__tree`, `ashlr__grep`,
`ashlr__read`, `ashlr__edit`, `ashlr__multi_edit`, `ashlr__bash`, `ashlr__bash_start`,
`ashlr__diff`.

**Note on `ashlr__bash`.** The bash tool runs arbitrary shell commands by design — the clamp
only restricts the shell's working directory, not the command string. A user can still run
`ls /etc` intentionally. What the clamp prevents is a prompt-injected caller pivoting the shell
into an ancestor directory (e.g., `cwd: "/"` or `cwd: "$HOME"`) to defeat the content-focused
refusals elsewhere or to run relative-path git operations on a parent repo.

**Known tradeoff:** running claude-code from one repo and asking a tool to operate on a sibling
repo will be refused. Workaround — launch claude-code from the common parent directory.

**Extending the allow-list (v1.14).** The clamp consults two optional env-var escape hatches:
- `CLAUDE_PROJECT_DIR` — if set (Claude Code exports this for hooks; `scripts/mcp-entrypoint.ts` forwards it into MCP subprocesses), the user's workspace is added to the allow-list so `ashlr__read` / `ashlr__grep` / `ashlr__edit` can operate on project files even though the MCP server's own `process.cwd()` is the plugin cache dir.
- `ASHLR_ALLOW_PROJECT_PATHS` — colon-separated list (semicolon on Windows) of additional root paths the user explicitly trusts. Intended for plugin developers dogfooding on the plugin's own source, and for multi-root workspaces. Prompt injection can't set env vars, so the allow-list stays under user control.

Any path outside all allow-listed roots is still refused with the same message shape.

### Genome team ownership (backend)

`server/src/routes/genome.ts` enforces team ownership on every read, write, and delete via
`requireGenomeAccess(id, teamId)`, which filters on `genomes.org_id = ?` at query time and
returns `null` on mismatch. Ownership failures always surface as `404` (not `403`) so existence
is never leaked to unauthorized callers. `POST /genome/init` stores the caller's team id
authoritatively from `getTeamForUser`, ignoring any `org_id` in the request body.

### Stripe webhook idempotency (backend)

`server/src/routes/billing.ts` processes each `stripe_events.event_id` exactly once. The claim is
atomic via `tryMarkStripeEventProcessed(eventId)` which runs
`INSERT INTO stripe_events (event_id) VALUES (?) ON CONFLICT (event_id) DO NOTHING` and returns
`true` only when the row was newly inserted. The handler runs **inside** the claim; if it throws,
`deleteStripeEvent(eventId)` rolls the marker back (wrapped in try/catch so a rollback failure
can't double-fault the route) and the route returns 500 so Stripe retries.

## GitHub OAuth Security (v1.13)

### Token encryption

GitHub access tokens are stored encrypted at rest using AES-256-GCM envelope encryption. Implementation: `server/src/lib/crypto.ts`. A master key (`ASHLR_MASTER_KEY` — 32 random bytes, base64-encoded) wraps a per-value random IV; the server throws fast on startup if the env var is absent. Tokens are decrypted on-demand server-side and never returned to the browser.

### OAuth state tokens

CSRF protection uses HMAC-signed state tokens with a 10-minute TTL. Comparison uses Node's `crypto.timingSafeEqual` to prevent timing-oracle attacks. State tokens are single-use and stored in `pending_auth_tokens` with a 3-minute freshness window for the CLI polling path.

### Rate limiting

IP-based rate limiting (20 requests / IP / hour) is applied to `/auth/github/start` and `/auth/github/callback`. The same shared bucket also covers `/auth/send` (magic-link). Limits are enforced server-side before any OAuth redirect.

### GitHub webhook signature verification

Incoming push-event webhooks are verified with HMAC-SHA256 using `GITHUB_WEBHOOK_SECRET`. Verification uses timing-safe comparison. Implementation: `server/src/routes/webhooks.ts:28-35`. Deliveries are deduplicated by GitHub delivery ID for idempotency.

### Scope minimization

Default OAuth scopes: `read:user user:email public_repo`. The `repo` scope (private-repo access) is only requested via an explicit step-up consent screen, separate from initial sign-in. Server enforces tier gating on private-repo genome builds independently of client-reported scope — a live `api.github.com` visibility check is performed server-side.

### Environment variable requirements

The server requires the following env vars for the OAuth + genome pipeline. Missing vars cause a fast startup failure (no silent degradation):

| Variable | Purpose |
|---|---|
| `GITHUB_CLIENT_ID` | OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | OAuth app client secret |
| `ASHLR_MASTER_KEY` | 32-byte base64 master key for AES-GCM token encryption |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for push-event webhook signature verification |
| `SITE_URL` | Canonical site URL (used in OAuth redirect URIs) |
| `BASE_URL` | API base URL (used in CLI polling + callback construction) |

---

## Past advisories

- **v1.11.2 — 2026-04-19.** Propagated the `process.cwd()` clamp from `ashlr__ls` to every
  other filesystem- or shell-touching MCP tool: `ashlr__glob`, `ashlr__tree`, `ashlr__grep`,
  `ashlr__read`, `ashlr__edit`, `ashlr__multi_edit`, `ashlr__bash`, `ashlr__bash_start`, and
  `ashlr__diff`. Before the patch, each of these accepted an arbitrary `cwd` or `path` argument
  and would walk the filesystem, spawn ripgrep/git/shell, read, or write against it — so a
  prompt-injected caller could enumerate `/etc`, exfiltrate `/etc/passwd` or `~/.ssh/id_rsa`,
  overwrite arbitrary files, or pivot the shell into a parent repo. Fixed by routing all ten
  tools through `servers/_cwd-clamp.ts`. The helper also caps its walk-up canonicalization loop
  at 32 segments to prevent a pathological long-path DoS. No public exploits observed.
- **v1.11.1 — 2026-04-19.** (1) Genome routes now enforce team ownership; previously any
  authenticated team-tier user who learned or guessed a genome UUID could read, write, or delete
  another team's genome. (2) Stripe webhook handling is now atomic; previously two concurrent
  deliveries of the same `event_id` could both read "not processed" and both fire the handler
  (double-grant, double-refund, double-email). Both gaps predated the surrounding features and
  were closed as a dedicated security patch.

## Acknowledgements

We keep a simple thank-you list in release notes for researchers who report responsibly.
