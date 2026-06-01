# Discoveries

Things agents have learned about the codebase and domain.

> High-signal, human-curated entries only. Raw auto-observations (JSON blobs,
> file listings, git diffs captured by the propose-loop) live in
> `discoveries-auto.md`, which is not indexed in the manifest and does not
> participate in genome retrieval. Promote entries up when they prove useful.


## Auto-observations · 2026-05-06
- [{"type":"text","text":" 1: /**\n 2: * _test-parsers — structured parsers for common test runner output.\n 3: *\n 4: * Each parser converts raw stdout+stderr into a TestResult with pass/fail/skip\n 5: * counts, duration, and per-failure details. Used by test-server-handlers.ts.\n 6: */\n 7: \n 8: export interface TestFailure {\n 9: file: string;\n 10: line?: number;\n 11: testName: string;\n 12: m…
- [{"type":"text","text":" 1: /**\n 2: * _embedding-model.ts — Pluggable embedder for the ashlr embedding cache.\n 3: *\n 4: * Day-1 strategy: BM25-style sparse pseudo-embedding via hash projection.\n 5: * - Tokenize input text (whitespace + punctuation split, lowercase).\n 6: * - Compute per-token IDF weights from a per-project corpus stored at\n 7: * ~/.ashlr/embed-corpus.json.\n 8: * - Project 
- [... 4831 bytes elided ...]
- type":"text","text":"# Architecture\n\n> Auto-populated from an ashlr baseline scan at genome init. Edit freely to\n> capture intent and tradeoffs that a scanner cannot see.\n\n## Snapshot\n\n- **Files scanned:** 87\n- **Runtime:** Bun\n- **Runtime notes:** package.json type=module; bun.lock present; walk: git ls-files\n- **Top extensions:** .ts (35), .md (34), .json (7), .sh (3), (none) (3), .…
- [{"type":"text","text":"(cached)\n# Changelog\n\nAll notable changes to ashlr-plugin. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n\n## [Unreleased]\n\n## [1.25.1] — 2026-04-29\n\n**Hotfix** — wires up multi-turn-stale tracking that v1.25.0 shipped as\ndead code, plus three Windows test flakes hardened.\n\n### Fixed\n\n- **Multi-turn-stale hook now actually fires.** v1.25.0 a…


## Auto-observations · 2026-05-07
- [{"type":"text","text":"---\nname: ashlr-spawn\ndescription: Spawn a named delegation pattern as one or more sub-agents. Patterns defined in _spawn-patterns.json.\nargument-hint: \"`<pattern>` [args...]\"\n---\n\nSpawn a named delegation pattern using `_spawn-patterns.json`.\n\n## Patterns available\n\n- `triage-issues` — classify open issues by severity / label / age (haiku, batch)\n- `refactor-f…
- [{"type":"text","text":" 1: #!/usr/bin/env bun\n 2: /**\n 3: * pretooluse-budget-guard.ts — Block tool calls when the session budget is exceeded.\n 4: *\n 5: * PreToolUse hook. Reads ASHLR_SESSION_BUDGET_USD or ASHLR_SESSION_BUDGET_TOKENS,\n 6: * estimates cumulative session spend from ~/.ashlr/session-log.jsonl, then:\n 7: * - warns at 80% (exits 0 with additionalContext nudge, event: budget_thre…
- [{"type":"text","text":" 1: #!/usr/bin/env bun\n 2: /**\n 3: * posttooluse-dedupe-output.ts — Elide duplicate tool results across turns.\n 4: *\n 5: * PostToolUse hook for Read / Grep / ashlr__read / ashlr__grep.\n 6: *\n 7: * When the same content (identified by contentSha8) was already seen from the\n 8: * same tool class (Read↔ashlr__read, Grep↔ashlr__grep) within the last 8\n 9: * turns of the…
- [{"type":"text","text":" 1: /**\n 2: * telemetry.ts — Opt-in anonymized telemetry ingest.\n 3: *\n 4: * POST /v1/events\n 5: *\n 6: * Accepts a batch of pre-anonymized events from `scripts/telemetry-flush.ts`\n 7: * (the v1.23 client). The client guarantees no paths/patterns/content; this\n 8: * route adds defense-in-depth by re-running the same `looksLikePath()` check\n 9: * server-side and dropp…


## Auto-observations · 2026-05-28
- [{"type":"text","text":"# ashlr-plugin\n\n> **Cut Claude Code token usage by −57% on real codebases.**\n> _TS −62% · Python −65% · Rust −44%_ — measured on `vercel/ai`, `pandas`, and `tokio`. ([methodology](docs/benchmarks.md))\n\n40 MCP tools that replace Claude Code's built-in `Read` / `Grep` / `Edit` / `Bash` and friends with versions that return **less** without losing what matters. PreToolUse…
- [{"type":"text","text":"(cached)\n 1: /**\n 2: * pretooluse-common.ts — Shared helpers for the pretooluse-{read,grep,edit}\n 3: * hooks. Each hook shells out via its own `bun run` entry in hooks.json, so we\n 4: * keep this module dependency-free and side-effect-free.\n 5: *\n 6: * Every helper is designed around the \"fail open\" contract: if anything looks\n 7: * unexpected we let the built-in
- [... 5233 bytes elided ...]
- type":"text","text":"---\nname: ashlr-plugin v1.13 roadmap decisions\ndescription: Strategic direction chosen for ashlr-plugin v1.13 after 2026-04-20 audit — which tracks are prioritized, what ships, what defers\ntype: project\noriginSessionId: f02e8c76-60e0-4c1d-8a5f-cf5ea9ffaada\n---\nOn 2026-04-20 a 4-agent audit of ashlr-plugin v1.12.0 produced a strategic roadmap; user picked all recommend…
- [{"type":"text","text":" 1: #!/usr/bin/env bun\n 2: /**\n 3: * scripts/benchmark-refs.ts\n 4: *\n 5: * Multi-repo aggregator for the ashlr-plugin token-efficiency benchmark.\n 6: *\n 7: * Iterates the three curated reference repos in bench/refs/:\n 8: * - node-sdk (TypeScript, vercel/ai subset)\n 9: * - python-lib (Python, pandas subset)\n 10: * - rust-project (Rust, tokio subset)\n 11: *\n 12: * …
-   enable smart summaries by configuring one of:
-     ANTHROPIC_API_KEY=…           (cloud, best quality)
-     /ashlr-ollama-setup           (local, free, no key)
-     ASHLR_LLM_URL=http://…/v1     (any OpenAI-compatible endpoint)


## Auto-observations · 2026-06-01
- [{"type":"text","text":"# Why I built a token-efficiency layer for Claude Code\n\nToken counts are a real operating cost. I started noticing it the same way you notice a slow memory leak: not all at once, but through accumulating evidence. The context window fills up faster than it should. Sessions hit the limit mid-refactor. The Anthropic invoice climbs past what feels proportionate to the actual…
- [{"type":"text","text":"# Social copy — ashlr v1.4.0 launch\n\n---\n\n## Twitter (3 variants, 280 char each)\n\n**Variant A — lead with the number**\n```\n−71.3% token savings on real codebases, measured and reproducible.\n\nashlr is an open-source Claude Code plugin: 17 MCP tools that replace native Read/Grep/Edit with compressed alternatives.\n\ncurl -fsSL plugin.ashlr.ai/install.sh | bash\n\nFu…
