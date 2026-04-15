# Hacker News launch post — v0.5.0

## Title options (pick one)

- **Show HN: Ashlr — open-source Claude Code plugin, mean −79.5% tokens on file reads**
- Show HN: Ashlr — token-efficient Read/Grep/Edit/SQL/Bash for Claude Code (MIT)
- Show HN: An open-source alternative to WOZCODE, with a real tokenizer

## URL

https://plugin.ashlr.ai/

## First comment (HN pattern — OP posts explanatory context)

Hi HN. I've been running Claude Code on Max for a few months and kept hitting context limits mid-session. The math that bothered me: every `Read` ships the full file, every `Grep` ships every match, every `Edit` ships the before-and-after — even when only the head and tail (or just the diff) are ever useful to the agent. On a 4-hour session over a mid-sized codebase, most of the context window is file content the model has already seen.

Ashlr is an open-source plugin that replaces Claude Code's built-in file/shell/SQL tools with lower-token versions via six MCP tools. v0.5.0 shipped this week.

**What's in it**

- `ashlr__read` — `snipCompact` on tool-results > 2 KB (head + tail, elide the middle). Mean **−79.5% on files ≥ 2 KB** in the benchmark harness. Raw data + reproducible command: [benchmarks.json](https://plugin.ashlr.ai/benchmarks.json).
- `ashlr__grep` — when the repo has a `.ashlrcode/genome/` directory (a sectioned, evolving project spec), retrieves top-scoring sections via TF-IDF or optional Ollama semantic search. Ripgrep fallback otherwise.
- `ashlr__edit` — applies the edit in place, returns only a diff summary.
- `ashlr__sql` — SQLite + Postgres in one tool call. `explain`, `schema`, password redaction. CSV-baseline savings math.
- `ashlr__bash` — shell with auto-compressed stdout. **stderr is never compressed** (errors reach the agent intact). Recognized commands (`git status`, `ls`, `ps`, `npm ls`) get structured summaries.
- `ashlr__tree` — gitignore-aware directory tree with a hard file cap.

Plus three agents in the WOZCODE tri-agent shape (sonnet main, haiku for exploration and planning) with explicit delegation rules, four hooks (tool-redirect, commit-attribution, edit-batching-nudge, session-start baseline scan), a savings-status-line, and `/ashlr-savings` which shows a dollar figure using a `ASHLR_PRICING_MODEL` env var you control.

**Three install paths**

1. `curl -fsSL plugin.ashlr.ai/install.sh | bash`, then two `/plugin` slash commands inside Claude Code.
2. Paste a prepared prompt ([plugin.ashlr.ai/install-prompt.md](https://plugin.ashlr.ai/install-prompt.md)) into any Claude Code session and the agent installs itself end-to-end.
3. Manual clone into `~/.claude/plugins/cache/ashlr-marketplace/ashlr` — every step visible.

**What I'm skipping on purpose, and why**

- **Small files (< 2 KB) see 0% savings** — `snipCompact` has a threshold because there's nothing to trim. I'd rather under-report than fudge.
- **Not faster on every task.** Savings compound over session length and file size distribution.
- **No MySQL in `ashlr__sql` yet.** Postgres + SQLite only. MySQL is on the roadmap but I didn't want to ship a half-tested driver.
- **Edit-batching is a nudge, not a rule.** The hook tells the agent "you've made 3 edits in 60s, consider batching" — it doesn't refuse the 4th edit. Rules felt too user-hostile.

**The tokenizer finding**

Most savings trackers in this space use `chars / 4` as a token estimate. I did too until I cross-checked against a real tokenizer. On code specifically, `chars/4` **overcounts by ~12.9%** relative to tiktoken cl100k_base (the closest public proxy — Anthropic's tokenizer isn't published). v0.5.0 uses tiktoken by default; numbers you see in `/ashlr-savings` reflect that. That's why the benchmark table may look slightly less flattering than older screenshots.

**The genome scribe loop — "thinks better, not just cheaper"**

v0.5 adds a scribe that updates `.ashlrcode/genome/` as the agent works. The genome isn't a one-time scaffold; it's a sectioned project spec that the agent keeps current. Next session's `ashlr__grep` gets a tighter, more relevant corpus than the last session ended with. This is the part I'm most interested in feedback on — whether the scribe writes useful sections or just accretes noise.

**Stack + ethics**

TypeScript + Bun + `@modelcontextprotocol/sdk`. MIT. No account, no login, zero telemetry — `git grep -E 'posthog|analytics|fetch.*(\.com|\.io)'` returns nothing except the one GitHub releases check in `/ashlr-doctor`. Stats live at `~/.ashlr/stats.json` locally.

The efficiency primitives live in a separate package, `@ashlr/core-efficiency`, that also powers my standalone CLI `ashlrcode`. One implementation, two consumers.

Landing (benchmark table, architecture, three install flows): https://plugin.ashlr.ai/
Repo: https://github.com/masonwyatt23/ashlr-plugin
Core lib: https://github.com/masonwyatt23/ashlr-core-efficiency
