# Reddit launch posts — v0.5.0

Two variants — pick one per subreddit. Please don't cross-post identical text; tailor lightly.

## r/ClaudeAI — Title

**Built an open-source Claude Code plugin — mean −79.5% tokens on file reads, MIT, zero telemetry**

## r/ClaudeAI — Body

Spent the last couple months hitting the Max plan's context limit on long sessions. The pattern that drove me nuts: every `Read` ships the whole file, every `Grep` ships every match, every `Edit` ships before-and-after — even when the agent only ever needed the head, tail, or diff.

**ashlr** is an open-source plugin that replaces Claude Code's built-in file/shell/SQL tools with lower-token MCP versions. v0.5.0 is live.

What it ships:

- `ashlr__read` — head + tail, elide the middle. **Mean −79.5% on files ≥ 2 KB** (reproducible benchmark in the repo).
- `ashlr__grep` — genome-RAG when `.ashlrcode/genome/` exists, ripgrep fallback otherwise.
- `ashlr__edit` — applies in place, returns diff summary only.
- `ashlr__sql`, `ashlr__bash`, `ashlr__tree` — same compression philosophy applied to database, shell, and directory listings.
- Real tokenizer (tiktoken cl100k_base) — ~12.9% more accurate than chars/4 on code.
- Savings status line + `/ashlr-savings` showing a dollar figure from `ASHLR_PRICING_MODEL`.

Install (one line):

```
curl -fsSL plugin.ashlr.ai/install.sh | bash
```

Then `/plugin marketplace add ashlrai/ashlr-plugin` and `/plugin install ashlr@ashlr-marketplace` inside Claude Code.

What v0.5 is still missing: MySQL driver for `ashlr__sql`, edit-batching is a nudge rather than an enforced rule, genome-RAG only helps on projects that bother to init a genome.

This is the open-source equivalent of WOZCODE — not a killer, not a replacement if you love their polish. MIT, no account, no telemetry, `~/.ashlr/stats.json` stays local. Feedback very welcome, especially on the tri-agent delegation heuristics.

Landing: https://plugin.ashlr.ai/
Repo: https://github.com/ashlrai/ashlr-plugin

---

## r/ClaudeCode — Title

**ashlr v0.5.0 — open-source MCP plugin, 6 efficient tools, real tokenizer, genome scribe loop**

## r/ClaudeCode — Body

For folks here who've been asking about WOZCODE alternatives: I've been building one in the open for a few weeks. v0.5.0 shipped this week.

Six MCP tools (`read`, `grep`, `edit`, `sql`, `bash`, `tree`) that replace the corresponding Claude Code built-ins. Three agents in the tri-agent shape (sonnet + haiku + haiku). Four hooks — tool-redirect, commit-attribution, edit-batching-nudge, session-start baseline scanner. Status line integration. `/ashlr-savings` with dollar figures, `/ashlr-doctor` for one-shot health check, `/ashlr-benchmark` to reproduce the numbers yourself.

New in v0.5:

- **Real tokenizer** via tiktoken cl100k_base. Found chars/4 overcounts by ~12.9% on code; numbers in `/ashlr-savings` are now honest.
- **Genome scribe loop** — the `.ashlrcode/genome/` spec gets maintained by a background scribe as the agent works. Next session starts with a tighter corpus than the last one ended with. Thinks better, not just cheaper.
- **Savings dashboard** with explicit `$` math respecting `ASHLR_PRICING_MODEL` (opus/sonnet/haiku).

Install:

```
curl -fsSL plugin.ashlr.ai/install.sh | bash
```

Honest framing: this is the **open-source equivalent** of WOZCODE — not a killer, not better-than. If you like WOZCODE's polish and don't mind the $20/week, use WOZCODE. This is for people who want the mechanism auditable, zero telemetry, and the efficiency library (`@ashlr/core-efficiency`) living in a separate repo they can fork.

v0.5 gaps: no MySQL yet, edit-batching is advisory, genome-RAG depends on you running `/ashlr-genome-init`.

Landing: https://plugin.ashlr.ai/
Repo: https://github.com/ashlrai/ashlr-plugin

Open to feedback — especially on the delegation heuristics (3+ orientation reads → `ashlr:explore`; 3+ file changes → `ashlr:plan`). When does handoff actually save tokens vs cost you context-transfer overhead?
