# ashlr Pro — Your Team Learns Together

_Version: v1.31.0 · Updated: 2026-05-08_

---

## The core idea

Free ashlr builds a genome that lives on your machine. Every session starts
from context you've already derived — but it's yours alone. The moment a team
forms, everyone re-derives the same codebase patterns from scratch.

Pro solves this. The genome becomes a shared, encrypted, versioned layer every
teammate retrieves from. One engineer's grep hit — a tricky auth flow, an
undocumented API edge case — becomes context for everyone who touches that code
next. New engineers onboard into accumulated knowledge, not silence.

---

## Pro ($12/mo or $120/yr) — individual cloud

- **Cross-machine sync** — savings ledger, streak counter, and `/ashlr-dashboard`
  follow you across machines automatically.
- **Cloud LLM summarizer** — `ashlr__read` and genome summarization run on
  hosted Haiku. No local Ollama or GPU required.
- **Hosted embedding retrieval** — `ashlr__grep` uses a cloud pgvector index
  refreshed on every push. Materially better recall on repos with > 5,000 files.
- **Weekly digest** — a personal summary of learnings, top tools, and streak
  milestones via `/ashlr-resume`.
- **7-day free trial on first checkout** — no charge until the trial ends,
  cancel any time.

Run `/ashlr-upgrade` from any Claude Code session to start.

---

## Pro Team ($24/user/mo, min 3 seats · or $20/user/mo annual)

Everything in Pro, plus:

- **Shared encrypted team genome** — E2E AES-256-GCM encrypted. Every
  section synced via vclock conflict detection. Divergent edits surface in
  `/ashlr-genome-conflicts` for human resolution. No plaintext leaves the
  client.
- **Org-wide savings dashboard** — aggregate savings, tool adoption, and
  streak rankings across all team members. Deduped per-repo.
- **Weekly team digest** — top genome sections hit, new discoveries, savings
  milestones across the team. Delivered via `/ashlr-resume` and optional email.
- **Policy packs** — centrally managed allow/deny lists for `ashlr__bash`,
  `ashlr__sql`, and destructive ops, pushed to every seat via the hook
  infrastructure. (Shipping — contact sales for early access.)
- **SSO + SCIM** — WorkOS integration for orgs that require it.
- **Audit log** — every non-read MCP tool call with commit linkage. SOC 2
  evidence export on request.

Run `/ashlr-upgrade --tier team` to start.

---

## What's never paywalled

Every MCP tool (all 45), every skill (all 31), the genome format, the local
scribe loop, per-session savings accounting, the benchmark harness, local
Ollama semantic search — all MIT, forever. Pro adds cloud infrastructure; it
does not remove or degrade anything in the free tier.

---

## Pricing summary

| Tier | Price | For |
|------|-------|-----|
| **Free** | $0, MIT forever | Every developer. Local-first. Full tool suite. Public-repo cloud genome. |
| **Pro** | $12/mo or $120/yr | One developer wanting cloud sync, hosted LLM, cross-machine dashboard. |
| **Pro Team** | $24/user/mo (min 3) or $20/user/mo annual | Engineering teams. Shared genome, org dashboard, policy packs, SSO. |
| **Enterprise** | Contact sales | On-prem, private inference, dedicated SLA, custom genome spec. |

**Downgrade path:** graceful. When a license lapses, the plugin routes to
free-tier fallbacks silently — no nag screens, no broken features. The genome
stays local. Cloud sync pauses.

---

## Technical architecture

**No fork.** One codebase. Pro features activate when `~/.ashlr/license.json`
validates against the Pro license server (signed JWT, 24h cache, works offline
for 30 days once cached).

**Retrieval fallback chain (Pro → free, never breaks):**
```
hosted pgvector → local Ollama → TF-IDF
```

**Genome sync** — `_genome-sync.ts` client, inactive without
`ASHLR_TEAM_GENOME_ID`. Uses the existing `proposeUpdate` /
`consolidateProposals` path; on consolidation it publishes a delta encrypted
with the team key to the Postgres-backed sync hub.

**Stats sync** — `ashlr-pro-telemetry` hook POSTs deltas of the per-session
ledger to a lightweight ingest endpoint. Opt-in, per-user toggleable, zero PII.

For architecture details see `docs/team-genome.md` and
`docs/github-oauth-onboarding.md`.
