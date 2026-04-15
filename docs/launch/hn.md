# Hacker News launch post

## Title options (pick one)

- **Show HN: Ashlr – open-source Claude Code plugin, -79.5% tokens on large file reads**
- Show HN: Ashlr – an open-source alternative to WOZCODE for Claude Code
- Show HN: Token-efficient Read/Grep/Edit for Claude Code (MIT, MCP)

## URL

https://plugin.ashlr.ai/

## First comment (HN pattern — OP posts explanatory context)

Hi HN. I've been hitting the Claude Code Max plan's context limit on mid-sized-codebase sessions and the math kept bothering me: every file the agent reads pays a full-contents tax, even when only the head and tail are useful.

Ashlr is an open-source Claude Code plugin that replaces the built-in file tools with lower-token alternatives via three MCP tools:

- **ashlr__read** — applies `snipCompact` to tool-results > 2 KB (head + tail, elide middle). Benchmarked mean −79.5% on files ≥ 2 KB (raw data + reproducible command at /benchmarks.json on the landing page).
- **ashlr__grep** — when the repo has a `.ashlrcode/genome/` directory (a sectioned, evolving project spec), returns top-scoring sections via TF-IDF or optional Ollama semantic search. Ripgrep fallback otherwise.
- **ashlr__edit** — applies the edit in place and returns only a diff summary instead of shipping full before/after.

Plus three agents (sonnet for the main driver, haiku for read-only exploration and planning) with explicit delegation rules so haiku soaks up orientation work and sonnet handles the actual edits.

The efficiency primitives aren't locked in the plugin. They live in a separate package, `@ashlr/core-efficiency`, that also powers my standalone CLI `ashlrcode`. One library, two consumers.

Honest about what it isn't:
- Small files (< 2 KB) see 0% savings — snipCompact only fires over a threshold. Don't oversell that.
- It's not faster on every task. Savings compound over session length and file sizes.
- WOZCODE pioneered the pattern; ashlr rebuilds it in the open. If you prefer their polish and don't mind $20/week, use them. This is for people who want the mechanism auditable.

Stack: TypeScript + Bun + MCP SDK. MIT. No account, no telemetry, no phone-home. Savings stats live at `~/.ashlr/stats.json` locally.

I'd love feedback on the tri-agent delegation rules — especially whether the "3+ orientation reads → delegate to explore" heuristic in the ashlr:code prompt triggers at the right cadence for real work.

Landing page (includes the benchmark table, the receipt mock, and a ledger of real per-call savings): https://plugin.ashlr.ai/
Repo: https://github.com/masonwyatt23/ashlr-plugin
Core lib: https://github.com/masonwyatt23/ashlr-core-efficiency
