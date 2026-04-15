# r/ClaudeAI and r/ClaudeCode launch posts

## r/ClaudeAI — Title

**I built an open-source Claude Code plugin that cuts ~80% of tokens on file reads**

## r/ClaudeAI — Body

I've been hitting the Max plan limit way too often on long sessions, so I spent a weekend building an open-source plugin that replaces Claude Code's built-in Read/Grep/Edit with token-efficient versions.

**The problem**
Every `Read` ships the full file. Every `Grep` ships every match. Every `Edit` ships both before and after. On a mid-sized codebase, a 4-hour session blows past 400 K tokens of context, and most of it is file content the model has already seen.

**What ashlr does**
Three MCP tools via a plugin you install inside Claude Code:

- `ashlr__read` — applies `snipCompact` to tool-results > 2 KB (keeps head + tail, elides middle). Benchmarked at **−79.5% on files ≥ 2 KB**, real data.
- `ashlr__grep` — when the repo has a `.ashlrcode/genome/` dir (a sectioned project spec), returns task-relevant sections via TF-IDF or Ollama semantic search. Ripgrep fallback otherwise.
- `ashlr__edit` — applies the edit in place, returns only a diff summary.

Plus a tri-agent setup (sonnet for main, haiku for exploration and planning) with explicit delegation rules.

**Install**
```
/plugin marketplace add masonwyatt23/ashlr-plugin
/plugin install ashlr@ashlr-marketplace
```

**Honest disclaimers**
- Files < 2 KB see 0% savings (snipCompact has a threshold — there's nothing to trim).
- WOZCODE ($20/week) pioneered this pattern. This is open-source, MIT, no account, no telemetry.
- It's v0.1 — please file issues.

Landing page (with real benchmark table, architecture diagram, and install flow): https://plugin.ashlr.ai/
Repo: https://github.com/masonwyatt23/ashlr-plugin

Happy to answer questions about how the compression + RAG actually works under the hood.

---

## r/ClaudeCode — Title

**Open-source alternative to WOZCODE — token-efficient Read/Grep/Edit for Claude Code, MIT, MCP-based**

## r/ClaudeCode — Body

Built an open-source plugin in the WOZCODE shape: three MCP tools that replace the built-in file primitives with lower-token versions, plus a tri-agent delegation pattern (sonnet + haiku + haiku).

Key differences from WOZCODE:
- MIT, source-auditable line by line
- No account, no telemetry
- Efficiency library (`@ashlr/core-efficiency`) is a separate package, also powers my standalone CLI
- Mean −79.5% savings on files ≥ 2 KB, with reproducible benchmark harness

Landing: https://plugin.ashlr.ai/
Repo: https://github.com/masonwyatt23/ashlr-plugin

Looking for feedback on the agent delegation rules (ashlr:code → ashlr:explore / ashlr:plan) — when does haiku delegation actually save tokens vs when does it cost you context-transfer overhead?
