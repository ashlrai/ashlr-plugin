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
- No telemetry. No phone-home. No analytics beacon.

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
`ashlr__read`, `ashlr__edit`, `ashlr__multi_edit`.

**Known tradeoff:** running claude-code from one repo and asking a tool to operate on a sibling
repo will be refused. Workaround — launch claude-code from the common parent directory.

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

## Past advisories

- **v1.11.2 — 2026-04-19.** Propagated the `process.cwd()` clamp from `ashlr__ls` to every other
  filesystem-touching MCP tool: `ashlr__glob`, `ashlr__tree`, `ashlr__grep`, `ashlr__read`,
  `ashlr__edit`, and `ashlr__multi_edit`. Before the patch, each of these accepted an arbitrary
  `cwd` or `path` argument and would walk the filesystem, spawn ripgrep, read, or write against
  it — so a prompt-injected caller could enumerate `/etc`, exfiltrate `/etc/passwd` or
  `~/.ssh/id_rsa`, or overwrite arbitrary files. Fixed by routing all seven tools through
  `servers/_cwd-clamp.ts`. The helper also caps its walk-up canonicalization loop at 32 segments
  to prevent a pathological long-path DoS. No public exploits observed.
- **v1.11.1 — 2026-04-19.** (1) Genome routes now enforce team ownership; previously any
  authenticated team-tier user who learned or guessed a genome UUID could read, write, or delete
  another team's genome. (2) Stripe webhook handling is now atomic; previously two concurrent
  deliveries of the same `event_id` could both read "not processed" and both fire the handler
  (double-grant, double-refund, double-email). Both gaps predated the surrounding features and
  were closed as a dedicated security patch.

## Acknowledgements

We keep a simple thank-you list in release notes for researchers who report responsibly.
