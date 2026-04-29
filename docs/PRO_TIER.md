# ashlr Pro Tier — Strategy

_Version: v1.18.0 · Updated: 2026-04-23_

This document maps out what a paid tier of ashlr looks like, sitting on top
of the MIT-licensed plugin. The guiding principle: **the free tier must stay
good enough to win by itself.** Pro exists to solve problems that genuinely
cost more to solve — not to paywall features that belong to the open-source
project.

---

## The free tier ships

Baseline in `v1.0.1`, MIT forever:

- **35 MCP tools** — `ashlr__read`, `ashlr__grep`, `ashlr__edit`,
  `ashlr__edit_structural` (v2: Unicode + cross-file + extract-function with
  return detection), `ashlr__multi_edit`, `ashlr__glob`,
  `ashlr__webfetch`, `ashlr__ask`, `ashlr__diff`, `ashlr__diff_semantic`,
  `ashlr__sql`, `ashlr__bash` (+ `_start`/`_tail`/`_stop`/`_list` control plane),
  `ashlr__tree`, `ashlr__http`, `ashlr__logs`, `ashlr__orient`,
  `ashlr__pr`, `ashlr__pr_comment`, `ashlr__pr_approve` (v1.18 PR write ops),
  `ashlr__issue`, `ashlr__issue_create`, `ashlr__issue_close`
  (v1.18 issue write ops), `ashlr__savings`, `ashlr__test`,
  `ashlr__genome_propose`, `ashlr__genome_consolidate`, `ashlr__genome_status`,
  `ashlr__ls`, `ashlr__flush`.
- **3 agents** — `ashlr:code` (sonnet), `ashlr:explore` (haiku),
  `ashlr:plan` (haiku). Tri-agent delegation pattern.
- **6 hooks** — `tool-redirect`, `commit-attribution`, `edit-batching-nudge`,
  `genome-scribe-hook`, `orient-nudge-hook`, `session-start`.
- **30 skills** — `/ashlr-help` (v1.18), `/ashlr-doctor`, `/ashlr-tour`, `/ashlr-status`,
  `/ashlr-savings`, `/ashlr-benchmark`, `/ashlr-settings`,
  `/ashlr-genome-init`, `/ashlr-genome-keygen`, `/ashlr-genome-team-init`,
  `/ashlr-genome-push`, `/ashlr-team-invite`, `/ashlr-recall`, `/ashlr-update`,
  `/ashlr-allow`, `/ashlr-usage`, `/ashlr-errors`, `/ashlr-demo`,
  `/ashlr-badge`, `/ashlr-legend`, `/ashlr-dashboard`,
  `/ashlr-handoff`, `/ashlr-genome-loop`, `/ashlr-ollama-setup`,
  `/ashlr-hook-timings`, `/ashlr-context-status`, `/ashlr-start`,
  `/ashlr-report-crash`, `/ashlr-upgrade`. (`/ashlr-coach` retired in v1.18.)
- **Genome scribe loop** — `propose` → `consolidate` with optional LLM merge,
  TF-IDF retrieval, optional Ollama semantic search, mutation audit trail.
  Auto-refresh via `_genome-live.ts`. Full architecture documented in
  `docs/team-genome.md`.
- **Per-session token accounting** — atomic writes, debounced flush, file lock.
  Surfaced via `/ashlr-usage` and `/ashlr-dashboard`.
- **Animated status line** — gradient sweep + activity pulse on every
  compressed output.
- **Fidelity confidence footers** — every compressed output carries a
  calibrated confidence score so you know what was elided.
- **Calibration harness** — grep baseline calibration via `calibrate.ts`.
  Reproducible benchmark in `docs/benchmarks.json`.
- **Fallback/escalation event emission** — every tool-redirect and escalation
  is emitted to the session log; `/ashlr-usage` surfaces the patterns.
- **Cursor + Goose ports** — `ports/README.md` documents how to wire the
  same tools into Cursor and Goose without the Claude Code plugin.
- **7-day Pro trial on first checkout** — `trial_period_days: 7`, no card
  required until trial ends. `ASHLR_DISABLE_TRIAL=1` ops kill switch.
- **Docs** — `docs/architecture.md`, `docs/team-genome.md`,
  `docs/ports/README.md`.
- **CI** — GitHub Actions pipeline: typecheck + test + smoke.
- **Test suite** — 794 tests pass, 1 skip, 0 fail.

---

## What's explicitly NOT paywalled, ever

Every feature in the list above is MIT, forever. Specifically:

- All 35 MCP tools and their full compression / retrieval logic (including v1.18's GitHub write ops, PreToolUse redirect mode, and unified `_pricing.ts`)
- The genome format (`.ashlrcode/genome/`) and scribe loop
- All 30 skills, including `/ashlr-dashboard`, `/ashlr-badge`, and `/ashlr-help`
- Per-session token accounting and the local `stats.json` ledger
- The tri-agent delegation pattern (`ashlr:code` / `explore` / `plan`)
- The savings benchmark and calibration harness
- Local Ollama semantic search
- All docs, ports, and CI tooling

Paywalling any of these would fragment the OSS community and is a permanent
mistake. The Pro tier adds capabilities that require infrastructure — it does
not remove or degrade anything in the free tier.

---

## Pro tier pillars

Five themes, each solving a real problem the free plugin structurally cannot:

### 0. Private-repo genome builds (individual Pro unlock)

The free tier can build cloud genomes from public GitHub repos. Private repos require Pro:

- Server enforces visibility via a live `api.github.com/repos/<owner>/<repo>` check — the client cannot fake it.
- Signing in with GitHub grants `read:user user:email public_repo` by default. Private-repo access triggers a `repo` scope step-up consent screen (explicit, separate from initial sign-in).
- Per-user genome encryption key (`users.genome_encryption_key_encrypted`) is auto-generated on first private-repo build; sections stored AES-GCM encrypted at rest.

See [docs/github-oauth-onboarding.md](github-oauth-onboarding.md) for the sign-in walkthrough and [docs/cloud-genome.md](cloud-genome.md) for the pipeline architecture.

---

### 1. Team genome — shared project memory across humans and agents

The genome is the single most defensible thing ashlr built. A local
`.ashlrcode/genome/` documented in `docs/team-genome.md` is the "brain" of
one developer on one machine. The `_genome-live.ts` auto-refresh keeps it
current within a session. But the moment a team forms, everyone re-derives
the same context from scratch every session.

Pro solves this with a hosted sync layer built on the existing
`proposeUpdate` / `consolidateProposals` path:

- **Shared encrypted team genome with vclock conflict detection** — every
  section is encrypted end-to-end (AES-256-GCM) before upload, vclock
  metadata in plaintext lets the server detect concurrent writes without
  decrypting content, and divergent edits are surfaced via
  `/ashlr-genome-conflicts` for human resolution. Backend is a Postgres
  + REST hub. CRDT auto-merge (Yjs) is on the roadmap as a v2 evolution.
- **Genome fitness dashboard** — per-section retrieval hit rates, staleness
  scores, and the `fitness.ts` output surfaced as a web view. Teams see
  which genome sections are carrying weight and which are dead weight.
- **Cross-repo genome federation** — link monorepo subprojects or
  microservices so `ashlr__grep` in one repo retrieves from a sibling's
  genome. Free tier is single-repo only.
- **Genome diffs on PRs** — a GitHub App runs `consolidateProposals` in
  dry-run mode against every PR diff and posts the proposed genome mutations
  as a reviewable check comment.

### 2. Team intelligence — policy, visibility, and billing at org scale

A free plugin is fine for one developer. The moment a 20-person team adopts
it, the CTO asks: "What's my actual savings, what can agents touch, and who
approved that?"

- **Org-level savings dashboard** — aggregates all team members' per-session
  stats (the same atomic-write ledger free users have locally) into a
  single org view, deduped per-repo.
- **Policy packs** — centrally managed allow/deny lists for `ashlr__bash`,
  `ashlr__sql`, and destructive ops, compiled into hook configs and pushed
  to every seat. The same hook infrastructure the free tier uses.
- **Audit log** — every MCP tool call with non-read intent streamed to an
  append-only log with commit linkage. SOC 2 evidence export on request.
- **SSO + SCIM** — WorkOS integration. Required at ~$50k ARR accounts and
  a hard blocker for most enterprise procurement.

### 3. Smarter retrieval — beyond TF-IDF and local Ollama

The free tier ships TF-IDF retrieval with an optional Ollama semantic layer
and a `servers/_genome-cache.ts` LRU cache for hot sections. That LRU is
per-process and evicts on restart. Pro extends the cache to the cloud and
replaces TF-IDF on large repos with something materially better:

- **Hosted embedding index** — cloud-managed pgvector index per repo,
  auto-refreshed by a webhook on push. The existing retrieval fallback chain
  (hosted → Ollama → TF-IDF) means free users degrade gracefully, never
  break. On repos with > 5k files, this is a qualitative jump, not a
  marginal one.
- **Symbol-graph retrieval** — tree-sitter AST parse + call graph. A query
  like "where does auth get the user id" returns the function body, its
  callers, and their tests — not a string-match blob.
- **Learned reranker** — log every retrieval + did-the-agent-use-it signal,
  fine-tune a small reranker. Retrieval quality compounds with usage.
  Nothing leaves the customer's VPC without explicit opt-in.
- **Multi-session memory** — cross-session retrieval from a per-user
  knowledge graph. The free tier's per-session accounting becomes a
  queryable history: "What was I debugging last Tuesday?"

### 4. Hosted services — cloud where the free tier requires local setup

The free tier requires local Ollama for semantic search and a local machine
for stats. Pro removes those dependencies:

- **Cloud LLM summarizer** — replaces the local Ollama requirement in
  `_summarize.ts`. Same 5s timeout and SHA-256 cache; the model is hosted,
  so no local GPU or LM Studio needed.
- **Cross-machine stats sync** — the per-session ledger syncs to a cloud
  endpoint. The `/ashlr-dashboard` becomes a persistent view across machines,
  not just the current session.
- **Hosted badge service** — the `/ashlr-badge` SVG becomes auto-updating.
  Free users generate a static SVG at save time; Pro users get a live URL
  that reflects current stats.
- **Leaderboard participation** — opt-in org leaderboard for savings
  percentiles by repo and model.

### 5. Enterprise — on-prem, private inference, SLA

For regulated industries and large orgs that cannot send data to a
shared cloud:

- **On-prem deployment** — the full Pro stack (embedding index, genome sync,
  org dashboard) running in the customer's own infrastructure.
- **Private inference** — genome summarization and reranking run against the
  customer's own model endpoint (any OpenAI-compatible API).
- **Dedicated support + SLA** — response time guarantees, named account
  engineer, incident escalation path.
- **Custom genome spec** — organizations with non-standard repo structures
  can extend the genome format beyond the public RFC.

---

## Pricing summary

| Tier | Price | What it's for |
|------|-------|---------------|
| **Free** | $0, MIT forever | Every individual developer. No account. Local-first. All 35 tools, 30 skills, genome, benchmarks. Public-repo cloud genome. |
| **Pro** | $12/mo or $120/yr | One developer who wants cloud-sync, cross-machine stats, and hosted LLM summarization without a local Ollama. |
| **Team** | $24/user/mo (min 3) or $20/user/mo annual | Engineering teams. Org dashboard, shared encrypted team genome (E2E + vclock conflict detection), policy packs, SSO, audit log. |
| **Enterprise** | Contact sales | On-prem, private inference, dedicated support, custom SLA. |

**Why these numbers:**

Sonnet-4.5 list pricing is $3/MTok input. Mean savings from the v1.0
benchmark is ~79% on files >= 2KB. A moderately active developer reads
200 files/day averaging 6KB — that's roughly $0.70/day saved on file-reads
alone, or $15/month before grep, edit, and diff savings are counted. Pro
at $12/month needs to cost less than it saves; it does, with margin. Team
at $24/user/month is where revenue lives: shared genome and policy packs
solve problems that have no free workaround.

**Downgrade path:** graceful. When a Pro or Team license lapses, the plugin
routes to free-tier fallbacks silently — no nag screens, no broken features.
The genome stays local. Cloud sync pauses. The badge becomes static.

---

## Technical architecture

**No fork.** The plugin stays one codebase. Pro features activate when
`~/.ashlr/license.json` validates against the Pro license server (signed
JWT, 24h cache, works offline for 30 days once cached). The free plugin
never breaks; Pro features become available when the license is present.

**Retrieval fallback chain (Pro → free, never breaks):**
```
hosted pgvector → local Ollama → TF-IDF
```
`ashlr__grep` gains a quality lift with a Pro license and zero agent-side
changes. The same tool call, better results.

**Genome sync** — `_genome-sync.ts` client, inactive without a
team genome configured (`ASHLR_TEAM_GENOME_ID` env). Uses the existing
`proposeUpdate` / `consolidateProposals` path; on consolidation success it
publishes a delta encrypted with the team key to the Postgres-backed sync
hub. Free users never see the sync code run.

**Stats sync** — a new `ashlr-pro-telemetry` hook POSTs deltas of the
per-session ledger (the same atomic-write file free users have locally) to
a lightweight ingest endpoint. Opt-in, per-user toggleable, zero PII.

**Migration path from free:** zero-friction. Run `ashlr-cli login`. The
license file is written. Next session picks it up. Same genome, same
settings, same agents — hosted index now available.

---

## Competitive positioning

**vs WOZCODE.** ashlr is MIT with a hosted Pro tier; WOZCODE is
closed-source commercial. The free tier wins on trust (auditable, forkable,
no telemetry). Pro has to close the polish gap on hosted features.

**vs Claude Code built-ins.** Anthropic will keep improving built-in
Read/Grep/Edit. ashlr's durable advantage is orthogonal: built-ins are
per-call tools; ashlr is a persistent context system (genome + retrieval +
savings telemetry) that makes built-ins cheaper. Anthropic is unlikely to
build genome-RAG because it's project-scoped and opinionated.

**vs Cursor / Windsurf.** Those are full IDEs. ashlr is a context layer
that runs inside Claude Code today and alongside any IDE via ports. The Pro
bet: the genome follows the developer whether they're in Claude Code, Cursor,
or VSCode. If that bet is right, Pro becomes context-as-a-service, not a
Claude Code add-on.

**Risks worth naming:**

1. **Anthropic ships managed agents + hosted context** — likely within 18
   months. Moat must be vendor-neutral depth (works with any LLM, any
   client), not just feature existence.
2. **Teams don't pay for "token savings"** — they pay for outcomes. The org
   dashboard and PR genome-diffs must frame savings as developer throughput,
   not cost cuts, to survive procurement.
3. **Genome format fragments** — if WOZCODE or anyone forks it with a
   different spec, interop breaks. Publish the genome spec as an RFC early
   and treat it as a community asset.

---

## TL;DR

Free ashlr wins on token efficiency for one developer. Pro ashlr wins on
team context — the genome goes from a local JSONL to a shared, live,
fitness-scored, hosted knowledge layer that every agent retrieves from.
Pricing is modest because the free tier has to stay excellent; revenue lives
in Team and Enterprise where shared genome, policy, and hosted services solve
problems the free tier structurally cannot.
