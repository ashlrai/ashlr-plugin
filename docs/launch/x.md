# X / Twitter launch post — v0.5.0

## Main thread (5 tweets)

**1/**
I measured every file my Claude Code agent read for a week. Mean overhead was 79.5% on files ≥ 2 KB — head and tail are useful, the middle almost never is.

So I built an open-source plugin that fixes it. Mean **−79.5% tokens**, MIT, no account, no telemetry.

plugin.ashlr.ai

---

**2/**
v0.5.0 ships six MCP tools that replace Claude Code's built-ins:

• `ashlr__read` — head + tail, elide the middle
• `ashlr__grep` — genome RAG, ripgrep fallback
• `ashlr__edit` — apply in place, return diff only
• `ashlr__sql` — SQLite + Postgres, one call
• `ashlr__bash` — auto-compressed stdout, stderr intact
• `ashlr__tree` — gitignore-aware, bounded

Plus a real tokenizer (tiktoken cl100k_base) — ~12.9% more accurate than chars/4 on code.

---

**3/**
New in v0.5: the genome scribe loop.

Your project's `.ashlrcode/genome/` isn't a one-time scaffold — the scribe updates it as the agent works. Next session starts with a tighter spec than the last one ended with.

It thinks better, not just cheaper.

---

**4/**
The ethical stack, because it matters:

• MIT-licensed, source-auditable line by line
• No account, no login, no API key needed beyond Claude's own
• Zero telemetry. `git grep posthog` returns nothing (WOZCODE's `.mcp.json` ships with PostHog baked in)
• Stats live in `~/.ashlr/stats.json` on your disk only

Status line shows live session + lifetime savings. `/ashlr-savings` shows the dollar amount.

---

**5/**
Install — one line:

```
curl -fsSL plugin.ashlr.ai/install.sh | bash
```

Or paste this into any Claude Code session and it'll install itself:
plugin.ashlr.ai/install-prompt.md

Source: github.com/masonwyatt23/ashlr-plugin

v0.5 limitations I know about: MySQL isn't wired yet, edit-batching is a nudge not a rule, genome RAG only helps on projects that have one. Feedback welcome.

## Standalone single post (if thread is too much)

Open-source Claude Code plugin, v0.5.0: six MCP tools, real tokenizer, genome scribe loop. Mean −79.5% tokens on files ≥ 2 KB. MIT, no account, zero telemetry. plugin.ashlr.ai
