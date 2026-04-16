# ashlr Pro Tier — Strategy

_Version: draft v1 · Target plugin baseline: v0.7.0_

This document maps out what a paid tier of ashlr would look like, sitting
on top of the MIT-licensed plugin. The guiding principle: **the free tier
must stay good enough to win by itself.** Pro exists to solve problems
that genuinely cost more to solve — not to paywall features that belong
to the open-source project.

---

## The free tier ships

Current baseline in `v0.7.0`, staying MIT forever:

- **11 MCP tools** — `ashlr__read`, `ashlr__grep`, `ashlr__edit`, `ashlr__sql`,
  `ashlr__bash` (+ `_start`/`_tail`/`_stop`/`_list` control plane),
  `ashlr__tree`, `ashlr__http`, `ashlr__diff`, `ashlr__logs`,
  `ashlr__orient`, `ashlr__pr`, `ashlr__issue`, `ashlr__savings`.
- **3 agents** — `ashlr:code` (sonnet), `ashlr:explore` (haiku),
  `ashlr:plan` (haiku). Tri-agent delegation pattern.
- **6 hooks** — `tool-redirect`, `commit-attribution`, `edit-batching-nudge`,
  `genome-scribe-hook`, `orient-nudge-hook`, `session-start`.
- **9 slash commands** — `/ashlr-doctor`, `/ashlr-tour`, `/ashlr-status`,
  `/ashlr-savings`, `/ashlr-benchmark`, `/ashlr-settings`,
  `/ashlr-genome-init`, `/ashlr-recall`, `/ashlr-update`.
- **Genome scribe loop** — `propose` → `consolidate` with optional LLM merge,
  TF-IDF retrieval, optional Ollama semantic search, mutation audit trail.
- **Local LLM summarization** — `_summarize.ts` routing to LM Studio by default,
  cloud override via env. 5s timeout → snipCompact fallback. 1h SHA-256 cache.
- **Status line + benchmark** — 7-day Braille sparkline, `docs/benchmarks.json`
  with reproducible script.

**What's not paywalled, ever:** single-user token efficiency, the genome
format, the savings dashboard, the tri-agent pattern, the `ashlr__*` tool
surface. Paywalling any of those would fork the OSS community and is a
permanent mistake.

---

## Pro tier pillars

Five themes, picked because each solves a real problem that the free
plugin structurally can't:

### 1. Team genome — shared project memory across humans and agents

The genome is the single most defensible thing ashlr built. A local
`.ashlrcode/genome/` is the "brain" of one developer on one machine. The
moment a team forms, everyone re-derives the same context from scratch
every session. Pro solves this with a hosted sync layer.

- **Shared remote genome** with CRDT-based merge, not last-write-wins.
- **Genome fitness dashboard** — per-section retrieval hit rates, staleness,
  fitness scores from `fitness.ts` surfaced as a web view.
- **Cross-repo genome federation** — link monorepo subprojects or
  microservices so `ashlr__grep` in one repo can retrieve from the linked
  genome of a sibling.
- **Genome diffs on PRs** — every PR shows the proposed genome mutations
  the scribe would apply, reviewable alongside code diffs.

### 2. Team intelligence — policy, visibility, and billing at org scale

A free plugin is fine for one hacker. The moment a 20-person team adopts
it, the CTO asks "what's my actual savings, what can agents touch, and
who approved that?"

- **Org-level savings dashboard** — aggregates all team members' stats.json
  files via a lightweight agent, deduped per-repo.
- **Policy packs** — centrally managed allow/deny lists for `ashlr__bash`,
  `ashlr__sql`, destructive ops, compiled into hook configs pushed to
  everyone on the team.
- **Audit log** — every MCP tool call with non-read intent (Edit, SQL writes,
  bash with mutation) streamed to an append-only log with commit linkage.
- **SSO + SCIM** — boring, required at ~$50k ARR accounts.

### 3. Smarter retrieval — the leap past TF-IDF

Current retrieval is TF-IDF with optional Ollama semantic. It works, but
it's nowhere near what's possible. This is where we can deliver *10x*
savings on large repos, not just 80% compression on individual files.

- **Hosted embedding index** — cloud-managed pgvector / Turbopuffer index
  per repo, auto-refreshed by a webhook on push. No local Ollama required.
  Retrieval quality jumps on repos with > 5k files where TF-IDF collapses.
- **Symbol-graph retrieval** — tree-sitter AST parse + call graph, so
  `ashlr__grep "where does auth get the user id"` returns the actual
  function body, its two callers, and their test, not a string-match blob.
- **Learned retrieval** — log every retrieval + did-the-agent-use-it signal
  (proxied via "was the file edited in the next N turns"), fine-tune a small
  reranker. User sees better top-k over time. Nothing ever leaves the
  customer's VPC if they don't want it to.
- **Multi-session memory** — cross-session retrieval from a per-user
  knowledge graph. "What was I debugging Tuesday at 3pm?" becomes a real
  query against structured session history.

### 4. Autonomous loops — agents that run when you're not there

The plugin today is reactive. A pro-tier agent runtime can run unattended
work: reviewing PRs, applying dependency bumps, triaging issues, keeping
the genome warm.

- **Scheduled agents** — cron-triggered `ashlr:code` runs with bounded
  token budget and a specific goal (e.g., "triage new issues nightly",
  "sweep dependabot PRs on Fridays"). Hooks into GitHub Actions or runs
  in Anthropic Managed Agents.
- **Event-driven agents** — webhook → agent. New issue → auto-draft reply
  using genome context. Failing CI → auto-propose fix PR with diff summary.
- **Budgeted worker pool** — the user sets a monthly token budget and a
  set of goals; the runtime picks the cheapest model that can plausibly
  succeed and reports back. Free plugin has no runtime — this is a
  genuinely separate product.

### 5. Deep-IDE integration — beyond Claude Code

Claude Code is one surface. Cursor, Windsurf, and direct-API users also
burn tokens. The Pro library should work everywhere the user codes.

- **LSP server** — `ashlr-lsp` exposing hover/go-to-def/completions that
  pull from genome. Works in VSCode, Neovim, JetBrains, anything speaking
  LSP. The built-in IDE + ashlr genome + zero Claude Code lock-in.
- **Universal MCP bundle** — same 11 tools, packaged as a standalone
  MCP server that any MCP-compatible client (Cursor, Zed, future clients)
  can add independently of the Claude Code plugin.
- **Team chat bot** — Slack/Discord bot answering "where is X implemented?"
  from the team genome. This is what "team genome" unlocks — a shared
  brain the whole team can ask questions of.

---

## Feature list (prioritized)

Ranked by (value × defensibility) / effort. "Effort" is engineering
weeks for a single developer, not calendar time.

| # | Feature | Value | Effort | Defensibility |
|---|---------|-------|--------|---------------|
| 1 | **Hosted embedding index + webhook refresh** | 10x retrieval quality on big repos; turns "genome works" into "genome always works and is instant" | 4–6 wk (pgvector infra, repo ingest worker, refresh invalidation, auth glue) | High — requires infra, not just code |
| 2 | **Shared team genome with CRDT merge** | Kills the per-developer context problem for any team > 3 people | 6–8 wk (CRDT, sync protocol, conflict UI, auth) | Very high — protocol + infra + UX |
| 3 | **Org savings dashboard** | Finance-visible ROI. Unlocks $50k+ ARR selling because CTO can point at a number | 2 wk (ingest endpoint, web UI, aggregation worker) | Low-medium — copyable but boring |
| 4 | **Symbol-graph retrieval (tree-sitter + callgraph)** | Step-change in retrieval accuracy on mature repos | 4 wk (ts parsers, graph builder, integration with retriever.ts) | Medium — the algorithm is public, the integration is the work |
| 5 | **Scheduled / event-driven agents** | Enables whole new use cases (nightly triage, auto-dependency bumps) | 5–7 wk (runtime, scheduler, budget enforcer, webhook router) | High — infra + reliability engineering |
| 6 | **Genome diffs on PRs (GitHub App)** | Every code review becomes a knowledge review. Sticky for teams. | 3 wk (GitHub App, PR check, scribe-in-CI mode) | High — requires GitHub App trust dance |
| 7 | **Policy packs + centrally pushed hook config** | Required to sell into regulated / larger orgs | 2 wk (schema, push mechanism, local loader) | Low but *necessary* for enterprise |
| 8 | **Cross-repo genome federation** | Monorepos-in-spirit: microservices / split repos get single-brain retrieval | 3 wk (federation config, cross-repo retrieval, auth) | Medium — novel but extends (1) |
| 9 | **LSP server** | Huge surface-area expansion; adoption path for non-Claude-Code users | 4 wk (LSP scaffolding, hover/defs/completions backed by retriever) | Medium — the work is the integrations, not the idea |
| 10 | **Audit log + SOC 2 evidence export** | Unblocks compliance-blocked buyers | 3 wk (append-only log, export formats, retention policy) | Low — commodity but required |
| 11 | **Learned reranker from usage telemetry** | Retrieval quality compounds over time; moat grows with usage | 6 wk (telemetry pipeline, training job, serving, privacy story) | Very high — data moat, hardest to replicate |
| 12 | **Multi-session memory / per-user knowledge graph** | "What was I doing last Tuesday" — sticky personal productivity feature | 4 wk (graph store, session ingest, query tools) | High — depends on accumulated history |
| 13 | **SSO + SCIM** | Enterprise table stakes | 2 wk (WorkOS or similar) | Low — commodity |
| 14 | **Team chat bot (Slack/Discord)** | Makes the genome useful to non-engineers. Discovery + adoption driver. | 3 wk (bot framework, genome query adapter, identity mapping) | Medium |
| 15 | **Universal MCP bundle (Cursor/Zed/etc.)** | Hedges against Claude-Code-only lock-in. Doubles the addressable audience. | 2 wk (repackaging + docs; code mostly exists) | Low — just packaging |

Items 1, 2, 3, 4, 5 are the v1 pillars. Items 6–9 are the v2 expansion
that turns Pro from "useful" into "indispensable for teams." Items 10–15
fall out of customer feedback as the tier matures.

---

## Technical architecture

How Pro features plug into the existing plugin without fragmenting users:

**No fork.** The plugin stays one codebase. Pro features activate when
`~/.ashlr/license.json` validates against the Pro license server (signed
JWT, 24h cache, works offline once cached for 30 days). The free plugin
never breaks; Pro features just become available.

**Where each feature lives:**

- **Hosted embedding index** — new `@ashlr/pro-embeddings` package. The
  genome retriever (`retrieveSectionsV2`) already has a fallback chain
  (Ollama → TF-IDF). Add a third layer: hosted pgvector. When license
  present and network available, try hosted first. Same API, same return
  type. The existing `ashlr__grep` gains a 3–10x quality lift on large
  repos with zero agent-side changes.
- **Shared team genome** — new `ashlr-genome-sync` MCP server shipped in
  the plugin but only active when a team genome is configured. Uses
  [Yjs](https://yjs.dev/) for CRDT merge; backend is a tiny websocket hub
  + object store (S3 + row per section in Postgres for metadata). The
  existing `proposeUpdate` / `consolidateProposals` path stays intact —
  consolidation fires an extra publish to the hub on success.
- **Org dashboard** — lightweight daemon (or lambda) that accepts POSTs
  of `~/.ashlr/stats.json` deltas from a new `ashlr-pro-telemetry` hook.
  Opt-in, per-user toggleable. Dashboard is plain Next.js on top of
  Postgres, read-only for seats, admin-editable for owners.
- **Symbol-graph retrieval** — new module in `@ashlr/core-efficiency`
  (MIT-licensable tree-sitter work is fine OSS, the *indexing infra* is
  the Pro bit). Free users get local in-process indexing on demand (slow
  on big repos). Pro users get pre-built graphs served from the same
  hosted index as embeddings.
- **Scheduled agents** — separate service, not in the plugin at all.
  Customers connect a GitHub App. The service uses Anthropic's Managed
  Agents API (or Claude Code Headless + harness) to run `ashlr:code` with
  a specified goal, budget, and repo scope. Reports back via PR comment,
  Slack, or email. Zero plugin changes.
- **Genome diffs on PRs** — GitHub App that runs a scribe-in-CI step:
  clones the PR head, runs `consolidateProposals` in dry-run mode against
  the diff, posts the proposed genome mutations as a PR check comment.
  Shares code with the existing scribe.
- **LSP server** — new `@ashlr/lsp` package that wraps the genome
  retriever and symbol graph as an LSP server. Pro users get the hosted
  index; free users get local indexing.

**Key constraint:** every Pro feature must have a graceful free-tier
fallback. `ashlr__grep` with a Pro license uses hosted embeddings; without,
it uses Ollama; without, TF-IDF. The experience degrades, but never
breaks. That's the contract that keeps the free tier healthy.

---

## Business model

**Pricing:**

| Tier | Price | Seats | Key features |
|------|-------|-------|--------------|
| Free / OSS | $0 | unlimited | All MCP tools, local genome, local Ollama, benchmarks, MIT forever |
| Pro | **$20/user/mo** | 1–10 | Hosted embeddings, shared genome (up to 3 repos), personal multi-session memory, priority support |
| Team | **$40/user/mo** | 10–100 | Everything in Pro + org dashboard, policy packs, genome diffs on PRs, SSO, unlimited repos |
| Enterprise | custom | 100+ | Everything in Team + scheduled agents, audit log, SOC 2 evidence, self-hosted option, SLA |

**Gating mechanism:** signed license JWT in `~/.ashlr/license.json`. The
plugin validates on session start, caches for 24h. If license is missing
or expired, Pro code paths silently route to free-tier fallbacks. No
nag screens, no disabled features that would be confusing.

**Migration path from free:** zero-friction. A free user becomes a Pro
user by running `ashlr-cli login` (new command), which writes the license
file. Next session picks it up. No reinstall, no config rewrite. The
same genome, the same settings, the same agents — just with the hosted
index now available.

**Why $20/seat is right:** Sonnet-4.5 pricing is $3/MTok input. Mean
savings of 79.5% on files ≥ 2KB in the current benchmarks. A moderately
active developer reads 200 files/day averaging 6KB. That's ~300k raw
tokens/day × 0.795 savings × $3/MTok = **$0.71/day saved on file-reads
alone**, or $15/month just on one tool. Add grep, bash, SQL, diff savings
and it's easily 2–4x that. Pro has to be cheaper than the savings it
enables, by a wide margin, or the math doesn't close.

**Honest tradeoffs:**

- **$20 is too cheap to pay for humans-in-the-loop support.** We'll have
  to be aggressive about in-product docs, `/ashlr-doctor` depth, and
  community support.
- **Team tier at $40 is where revenue lives.** Pro at $20 is a loss-leader
  / wedge. We should not chase seat count at Pro — we should chase
  team-tier conversions.
- **Usage-based pricing would be more honest** (pay per token saved) but
  ops-heavy. Deferred to v3 unless a big customer asks.

---

## Roadmap

### v1 (launch) — "Pro works for individuals"

- Hosted embedding index + webhook refresh
- Personal multi-session memory
- License file plumbing, `ashlr-cli login`
- Documentation, landing page section, migration guide

Target: 12 weeks. Ship with a public waiting list opened alongside
v0.7.0. First 100 users free for 3 months in exchange for usage
telemetry + feedback.

### v2 — "Pro works for teams"

- Shared team genome with CRDT merge
- Org savings dashboard
- Genome diffs on PRs (GitHub App)
- Policy packs
- SSO

Target: 16 weeks after v1.

### v3 — "Pro replaces team tooling"

- Symbol-graph retrieval
- Scheduled / event-driven agents
- Audit log + SOC 2 prep
- Learned reranker
- LSP server

Target: 24 weeks after v2. v3 is where the product stops being "Claude
Code for teams" and starts being "the context layer for AI-assisted
engineering."

---

## Competitive positioning

**vs WOZCODE.** ashlr is MIT with a hosted Pro tier; WOZCODE is
closed-source commercial. We win on trust (auditable free tier), lose on
polish (they've had more time on the hosted layer). The Pro tier must
close the polish gap: hosted embeddings and team sync need to feel at
least as good as WOZCODE's equivalent, or better.

**vs Claude Code built-ins.** Anthropic will keep improving the built-in
Read/Grep/Edit. ashlr's durable advantage is *orthogonal*: built-ins are
per-call tools; ashlr is a *persistent context system* (genome +
retrieval + savings telemetry) that makes built-ins cheaper. Anthropic
is unlikely to build genome-RAG because it's project-scoped and
opinionated. As long as we stay above the tool layer, we're not directly
competing.

**vs Cursor / Windsurf.** Those are full IDEs. ashlr is a library + Pro
service layer that runs *inside* Claude Code (today) and *alongside*
IDEs (v3 LSP). The Pro bet is that the context layer matters more than
the IDE — that the same genome should follow the developer whether they're
in Claude Code, Cursor, or VSCode. If that bet is right, the Pro tier
becomes a horizontal context-as-a-service play, not a Claude Code add-on.

**vs "just use Cursor with MCP."** Cursor will add MCP and some will use
our tools there — fine. Our Pro differentiator isn't the MCP tools (those
stay free and open). It's the hosted index, team genome, and agent runtime.
Cursor isn't going to build those for their own users because their
business is the IDE, not the shared-brain layer.

**Risks worth naming honestly:**

1. **Anthropic ships managed agents + hosted context themselves** — likely
   within 18 months. Our moat has to be vendor-neutral context (works
   with any LLM provider, any client) and depth of retrieval quality,
   not just existence of the features.
2. **Teams don't pay for "token savings"** — they pay for outcomes. The
   org dashboard and PR genome-diffs have to frame savings as *developer
   throughput*, not cost cuts, to survive procurement.
3. **The genome format fragments** — if WOZCODE (or anyone) forks it with
   a different spec, interop breaks. We should publish the genome spec
   as an RFC early and treat it as a community asset, not Pro lock-in.

---

## TL;DR

Free ashlr wins on token efficiency for one developer. Pro ashlr wins on
*team context* — the genome goes from a local JSONL to a shared, live,
fitness-scored, hosted knowledge layer that every agent (in Claude Code
today, everywhere tomorrow) retrieves from. Pricing is modest because the
free tier has to stay excellent; the revenue lives in the Team and
Enterprise tiers where shared genome, policy, and autonomous agents
solve problems the free tier structurally can't.

Ship v1 in 12 weeks. Waitlist now.
