# ashlr pricing

**Ship less context. Keep more money.**
ashlr Pro adds cloud genome sync, hosted retrieval, and cross-machine
dashboards — on top of a free tier that is already a complete, production-
grade token-efficiency layer.

---

## Plans

| | **Free** | **Pro** | **Team** |
|---|---|---|---|
| **Price** | $0 forever | $12/mo or $120/yr | $24/user/mo or $20/user/mo annual (min 3 users) |
| **For** | Every developer, forever | One developer who wants cloud | Engineering teams |
| | | | |
| 33 MCP tools | Yes | Yes | Yes |
| 29 skills | Yes | Yes | Yes |
| Local genome + scribe loop | Yes | Yes | Yes |
| Per-session token ledger | Yes | Yes | Yes |
| Tri-agent delegation | Yes | Yes | Yes |
| Savings benchmark + badge | Yes | Yes | Yes |
| Cursor + Goose ports | Yes | Yes | Yes |
| Cloud LLM summarizer (no Ollama required) | No | Yes | Yes |
| Cross-machine stats sync | No | Yes | Yes |
| Live auto-updating badge | No | Yes | Yes |
| Leaderboard participation | No | Yes | Yes |
| Priority support | No | Yes | Yes |
| Shared CRDT team genome | No | No | Yes |
| Org savings dashboard | No | No | Yes |
| Policy packs + pushed hook config | No | No | Yes |
| Genome diffs on PRs | No | No | Yes |
| SSO + SCIM | No | No | Yes |
| Audit log + SOC 2 evidence export | No | No | Yes |
| **CTA** | **Start free** | **Upgrade** | **Contact sales** |

Enterprise (on-prem, private inference, dedicated SLA): [contact sales](mailto:support@ashlr.ai).

---

## Detailed feature list

### Free — everything you need as an individual

- **33 MCP tools**: `ashlr__read`, `ashlr__grep`, `ashlr__edit`,
  `ashlr__edit_structural` (v2: Unicode + cross-file + extract-function with
  return-value detection), `ashlr__multi_edit`, `ashlr__glob`,
  `ashlr__webfetch`, `ashlr__ask`, `ashlr__diff`, `ashlr__diff_semantic`,
  `ashlr__sql`, `ashlr__bash` (+ `_start`/`_tail`/`_stop`/`_list`),
  `ashlr__tree`, `ashlr__http`, `ashlr__logs`, `ashlr__orient`,
  `ashlr__test`, `ashlr__ls`, `ashlr__flush`, `ashlr__savings`,
  `ashlr__pr` / `ashlr__pr_comment` / `ashlr__pr_approve`,
  `ashlr__issue` / `ashlr__issue_create` / `ashlr__issue_close` (v1.18 GitHub
  write ops), and the three `ashlr__genome_*` tools.
- **29 skills** including `/ashlr-help` (v1.18), `/ashlr-dashboard`,
  `/ashlr-badge`, `/ashlr-demo`, and `/ashlr-tour`.
- Local genome with automatic propose/consolidate loop and TF-IDF retrieval.
- Optional local Ollama semantic search.
- Per-session atomic token ledger with fidelity confidence footers on every
  compressed output.
- Animated status line with gradient sweep and activity pulse.
- Calibration harness and reproducible benchmark against your own codebase.
- Cursor and Goose ports documented in `docs/ports/README.md`.
- 794 passing tests, MIT license, no telemetry, forkable.

### Pro — cloud for one developer

Everything in Free, plus:

- **Cloud LLM summarizer** — removes the local Ollama requirement. Genome
  summarization runs on hosted infrastructure with the same 5s timeout and
  SHA-256 cache you already rely on.
- **Cross-machine stats sync** — your per-session ledger syncs across
  machines so `/ashlr-dashboard` reflects your real history, not just the
  current session.
- **Live badge** — the `/ashlr-badge` SVG URL auto-updates. Embed it in
  your README and it always shows current savings without re-running.
- **Hosted embedding retrieval** — `ashlr__grep` uses a cloud pgvector
  index refreshed on every push, falling back to Ollama and then TF-IDF.
  Material quality improvement on repos with more than 5,000 files.
- **Leaderboard** — opt-in comparison of savings percentiles across repos
  and models.
- **Priority support** — response within one business day.

### Team — shared context for engineering teams

Everything in Pro, plus:

- **Shared CRDT genome** — one authoritative genome per repo, CRDT-merged
  so concurrent edits from different team members never clobber each other.
- **Org savings dashboard** — aggregate view of every seat's per-session
  ledger, deduped per-repo, visible to team admins.
- **Policy packs** — centrally authored allow/deny lists for `ashlr__bash`,
  `ashlr__sql`, and destructive operations, compiled into hook configs
  pushed to every seat automatically.
- **Genome diffs on PRs** — GitHub App posts proposed genome mutations
  alongside every code diff. Knowledge review as part of code review.
- **SSO + SCIM** — WorkOS integration for identity management.
- **Audit log** — append-only log of every non-read MCP tool call with
  commit linkage. Exportable for SOC 2 evidence.

### Enterprise

On-prem deployment of the full Pro/Team stack in your own infrastructure.
Private inference endpoint (any OpenAI-compatible API). Dedicated support
engineer, named SLA, custom genome spec. [Get in touch.](mailto:support@ashlr.ai)

---

## FAQ

**Is the free tier crippled?**

No. Never. The free tier ships 33 MCP tools, 29 skills, the full genome
scribe loop, per-session token accounting, a calibration harness, and a
benchmark suite. It is the product. Pro adds cloud infrastructure for
developers who need it — it does not remove or degrade anything in the free
tier. The MIT license means you can audit every line and fork if you
disagree.

**Can I self-host everything?**

Yes. The free tier is entirely local — no account, no outbound calls unless
you opt in. The Pro cloud features (hosted embedding index, genome sync, stats
endpoint) are conveniences, not requirements. If you want to run the full
stack on your own infrastructure, the Enterprise tier covers exactly that.
The genome format is a public spec; nothing is locked to our servers.

**What data leaves my machine?**

On the free tier: nothing. The genome lives in `.ashlrcode/genome/`, the
stats ledger lives in `~/.ashlr/stats.json`, and no data is sent anywhere.
On Pro, only what you explicitly opt into: the stats ledger sync and the
cloud summarizer calls. Both are toggleable. We do not log prompt content,
file contents, or anything identifiable beyond aggregate token counts and
repo-level metadata. On Enterprise/on-prem, nothing leaves your VPC.

**How is this different from WOZCODE?**

ashlr is open source (MIT). WOZCODE is a closed-source commercial product.
With ashlr you can read the compression logic, fork the genome format, run
the benchmark against your own codebase, and verify the savings claims
yourself. The Pro tier adds hosted infrastructure on top of that auditable
base — it does not replace the open-source plugin with a black box.

**What happens if I downgrade from Pro or Team to free?**

Graceful. The plugin detects the missing or expired license on next session
start and silently routes to free-tier fallbacks. The cloud LLM summarizer
falls back to local Ollama (if installed) and then to the built-in snip
compactor. Genome sync pauses; your local genome is untouched. The badge
becomes static. No features break; no data is deleted. You can re-upgrade
at any time and cloud sync resumes from where it left off.

**Can I see it work before paying?**

Yes. The `/ashlr-demo` and `/ashlr-tour` skills ship free and run a
30-second to 60-second scripted showcase of token savings on your actual
codebase. Run `/ashlr-benchmark` for a reproducible, auditable savings
number against your repo before spending a dollar.

**Do you use my code or prompts to train models?**

No. Not ever. Session content, file contents, and prompt text are not
retained for training. The only data we collect on Pro is aggregate token
counts and repo-level metadata for the savings ledger — nothing that
identifies code or conversations. This is a hard commitment, not a policy
that can be quietly revised in a ToS update.

**How does billing work? Do you support invoicing or POs?**

Pro and Team tiers are billed via Stripe (card). Annual plans are invoiced
upfront. For purchase orders, net-30 terms, or invoicing workflows, contact
[support@ashlr.ai](mailto:support@ashlr.ai) — standard
PO terms are available for Team and Enterprise.

**What is the minimum team size for the Team tier?**

Three users. At fewer than three seats the overhead of shared genome sync
and org policy management adds more complexity than it saves. Solo developers
and pairs are better served by Pro.

**Will pricing change?**

Pro at $12/month and Team at $24/user/month are the launch prices. Existing
subscribers are grandfathered at the price they signed up at. We will not
raise prices on existing subscriptions without at least 90 days notice and
an opt-out window.

---

## Full feature comparison

| Feature | Free | Pro | Team |
|---------|------|-----|------|
| MCP tools (14 total) | All | All | All |
| Skills (23 total) | All | All | All |
| Genome scribe loop | Yes | Yes | Yes |
| TF-IDF retrieval | Yes | Yes | Yes |
| Local Ollama semantic search | Yes | Yes | Yes |
| Hosted embedding retrieval | No | Yes | Yes |
| Per-session token ledger | Yes | Yes | Yes |
| Fidelity confidence footers | Yes | Yes | Yes |
| Animated status line | Yes | Yes | Yes |
| Calibration harness | Yes | Yes | Yes |
| Savings benchmark | Yes | Yes | Yes |
| Static savings badge | Yes | Yes | Yes |
| Live auto-updating badge | No | Yes | Yes |
| Cloud LLM summarizer | No | Yes | Yes |
| Cross-machine stats sync | No | Yes | Yes |
| Leaderboard participation | No | Yes | Yes |
| Cursor + Goose ports | Yes | Yes | Yes |
| Priority support | No | Yes | Yes |
| Shared CRDT team genome | No | No | Yes |
| Org savings dashboard | No | No | Yes |
| Policy packs | No | No | Yes |
| Genome diffs on PRs | No | No | Yes |
| SSO + SCIM | No | No | Yes |
| Audit log | No | No | Yes |
| SOC 2 evidence export | No | No | Yes |
| On-prem deployment | No | No | Enterprise |
| Private inference endpoint | No | No | Enterprise |
| Dedicated support + SLA | No | No | Enterprise |

---

## Open source forever

ashlr is MIT-licensed. The full plugin — all 33 tools, all 29 skills, the
genome format, the scribe loop, the benchmark harness, and every line of
compression logic — is and will remain open source. No feature that exists
in the free tier today will ever move behind a paywall. The Pro and Team
tiers add new capabilities that require infrastructure to deliver; they do
not erode what is already free.

You are welcome to fork, audit, and self-host. If you find a bug, open an
issue. If you find a security issue, please disclose it privately first.
The genome spec is published as a community asset — we want the format to
outlast any particular implementation, including this one.

If the paid tiers succeed, the open-source project gets better maintained.
If they don't, the plugin stays free and useful regardless. That is the
intended relationship between the two, and it is not going to change.
