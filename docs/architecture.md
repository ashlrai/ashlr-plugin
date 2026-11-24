# ashlr-plugin Architecture

Reference for contributors. Covers system shape, data flows, and conventions. All file references are relative to the plugin root unless otherwise noted.

> **Platform support:** ashlr-plugin runs on Windows, macOS, and Linux. Host hooks use `node scripts/hook-bootstrap.mjs` to launch TypeScript under Bun. The registered events and script paths are in `hooks/hooks.json` for Claude Code and `hooks/codex-hooks.json` for Codex; see the [README hook table](../README.md#hooks). See [install-windows.md](install-windows.md) for Windows-specific notes.

---

## 1. Overview

ashlr-plugin is a multi-host plugin for Codex and Claude Code that wraps file, search, edit, and shell workflows with lower-token alternatives and adds a lightweight observability layer over tool usage and cost.

Two value propositions:

**Token efficiency.** `ashlr__read`, `ashlr__grep`, and `ashlr__edit` replace the built-in `Read`, `Grep`, and `Edit` tools. Large file reads are snip-compacted or LLM-summarized; grep calls route through a per-project genome index (RAG) when one exists, cutting tokens on warm queries (not covered by the published benchmark); edits send only diffs, not full file contents.

**Observability.** Every tool call is accounted in `~/.ashlr/stats.json` (per-session + lifetime counters) and appended to `~/.ashlr/session-log.jsonl`. Claude Code surfaces savings in the status line; Codex surfaces them through MCP tools, CLI commands, and skills. The genome scribe loop extracts architectural knowledge from tool results into `.ashlrcode/genome/`, which feeds back into future grep routing.

The Claude Code wiring entry point is `.claude-plugin/plugin.json`. The Codex wiring entry point is `.codex-plugin/plugin.json` with `.mcp.json` and `hooks/codex-hooks.json`.

---

## 2. MCP Server Map

Source of truth: `.claude-plugin/plugin.json:mcpServers`. As of v1.13, **a single `ashlr` router entry** replaces the previous 16 per-server entries. The router at `servers/_router.ts` dispatches all 54 tools through the shared `registerTool` / `getTool` registry in `servers/_tool-base.ts`. `plugin.json` has one `mcpServers` entry:

```json
"ashlr": {
  "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs", "servers/_router.ts"]
}
```

The node bootstrap (`scripts/bootstrap.mjs`) ensures Bun is available before handing off to the bun-native entrypoint (`scripts/mcp-entrypoint.ts`). The entrypoint replaces the legacy bash wrapper so the plugin runs on Windows without Git Bash. It handles first-run `bun install`, stale-sibling version cache cleanup, and `CLAUDE_SESSION_ID` forwarding. The dedicated `ashlr-mcp` bin launches the same router path for Codex and other MCP hosts without invoking the stats CLI.

`ASHLR_ROUTER_DISABLE=1` exits the router. The current manifest has no legacy per-server entries, so this disables its tools rather than restoring another server mode.

### Tool registry (all 54 default tools; `ashlr__pipe` is opt-in)

| Tool | Handler module (catalog `module`) | Replaces (native) |
|---|---|---|
| `ashlr__read` | `servers/read-server-handlers.ts` | `Read` |
| `ashlr__grep` | `servers/grep-server-handlers.ts` | `Grep` |
| `ashlr__edit` | `servers/edit-server-handlers.ts` | `Edit` (baseline is `search+replace` bytes as of v1.18 Trust Pass) |
| `ashlr__edit_structural` | `servers/edit-structural-server-handlers.ts` | (v2 as of v1.18: Unicode identifiers, cross-file rename with `anchorFile`/`maxFiles`/shadowing guard/dryRun, extract-function with return-value detection) |
| `ashlr__multi_edit` | `servers/multi-edit-server-handlers.ts` | — |
| `ashlr__savings` | `servers/savings-server-handlers.ts` | — |
| `ashlr__flush` | `servers/flush-server-handlers.ts` | — |
| `ashlr__bash` | `servers/bash-server-handlers.ts` | `Bash` (v1.18: process-group SIGKILL on timeout, pluggable summarizer registry) |
| `ashlr__bash_start` / `_stop` / `_tail` / `_list` | `servers/bash-server-handlers.ts` | — (long-running control plane) |
| `ashlr__diff` | `servers/diff-server-handlers.ts` | — |
| `ashlr__diff_semantic` | `servers/diff-semantic-server-handlers.ts` | — |
| `ashlr__sql` | `servers/sql-server-handlers.ts` | — |
| `ashlr__tree` | `servers/tree-server-handlers.ts` | — |
| `ashlr__http` | `servers/http-server-handlers.ts` | `WebFetch` |
| `ashlr__logs` | `servers/logs-server-handlers.ts` | — |
| `ashlr__genome_propose` / `_consolidate` / `_status` | `servers/genome-server-handlers.ts` | — |
| `ashlr__orient` | `servers/orient-server-handlers.ts` | — |
| `ashlr__issue` / `ashlr__pr` | `servers/github-server-handlers.ts` | — (wraps `gh` CLI) |
| `ashlr__pr_comment` / `ashlr__pr_approve` | `servers/github-server-handlers.ts` | — (v1.18 PR write ops; `pr:"current"` via `gh pr view`, self-approval guard, `ASHLR_REQUIRE_GH_CONFIRM=1`) |
| `ashlr__issue_create` / `ashlr__issue_close` | `servers/github-server-handlers.ts` | — (v1.18 issue write ops; no destructive ops) |
| `ashlr__glob` | `servers/glob-server-handlers.ts` | `Glob` |
| `ashlr__ls` | `servers/ls-server-handlers.ts` | — |
| `ashlr__webfetch` | `servers/webfetch-server-handlers.ts` | `WebFetch` (summarizes at 4 KB as of v1.18) |
| `ashlr__ask` | `servers/ask-server-handlers.ts` | — |
| `ashlr__test` | `servers/test-server-handlers.ts` | — (bun/vitest/jest/pytest/go test parser; v1.18: async spawn + `bun.lock` text detection) |
| `ashlr__write` | `servers/write-server-handlers.ts` | `Write` |
| `ashlr__rename_file` | `servers/rename-file-server-handlers.ts` | — (moves a file and rewrites every import specifier that resolves to it) |
| `ashlr__search_replace_regex` | `servers/search-replace-regex-server-handlers.ts` | — (bulk regex substitution across files) |
| `ashlr__websearch` | `servers/websearch-server-handlers.ts` | `WebSearch` |
| `ashlr__task_list` / `_get` | `servers/task-server-handlers.ts` | — (task-graph viewer) |
| `ashlr__notebook_edit` | `servers/notebook-edit-server-handlers.ts` | `NotebookEdit` |
| `ashlr__fleet_state` / `_events` / `_intent` / `_session` / `_act` / `_snapshot` / `_direction` / `_lanes` / `_proposals` / `_propose` / `_ghosts` / `_dirty_triage` / `_browser` / `_resources` | `servers/fleet-*-server-handlers.ts` | — (fleet coordination plane: reads, intents, steering, health) |
| `ashlr__pipe` | `servers/pipe-server-handlers.ts` | — (opt-in `ASHLR_PIPE_ENABLE=1`; excluded from the default count) |

How a call reaches a handler:

1. `servers/_tool-catalog.json` holds each tool's name, description, input schema and handler `module`. It is generated by `bun run gen:tool-catalog`, not hand-edited.
2. At startup the router calls `registerLazyTools()` from `servers/_lazy-tools.ts`. It registers a placeholder for every catalog entry, so `initialize` and `tools/list` answer without importing any handler. Entries with an `enableEnv` (such as `ashlr__pipe`) register only when that variable is `1`.
3. The first `tools/call` for a tool dynamic-imports its handler module. The module calls `registerTool` at import time, which replaces the placeholder, and the call is forwarded. The `CallToolRequestSchema` handler in `_tool-base.ts::runStandalone` wraps each call in `try/catch`, so one throwing handler returns `isError: true` instead of killing the process.

`servers/_router-handlers.ts` still eager-imports every handler module. The `ashlr-plugin tools` CLI, `bun run smoke:tools` and `scripts/gen-tool-catalog.ts` use it. All tools share one process and one stdin/stdout pair; nothing spawns a process per server.

### Shared infrastructure modules

- **`servers/_pricing.ts`** (v1.18) — single source of truth for $/MTok across the plugin. Consumed by the savings renderers in `servers/` (`efficiency-savings.ts`, `_savings-render.ts`), `scripts/savings-dashboard.ts`, `scripts/savings-status-line.ts`, `scripts/session-greet.ts`, and others. Prior to v1.18 each surface hardcoded its own rate, producing three different dollar values for the same token count. The model comes from `ASHLR_PRICING_MODEL`, then `CLAUDE_CODE_MODEL`, then `DEFAULT_PRICING_MODEL` (currently `sonnet-4.6`); `PRICING_TABLE` in that file lists the supported models, and unknown names fall back to the default.
- **`servers/_bash-summarizers-registry.ts`** (v1.18) — pluggable registry of structured summarizers for `ashlr__bash` output. Keyed by command prefix, each entry returns a compact summary for matched output (`git log`, `git diff`, `git show`, unified test-runner output across jest/vitest/pytest/bun/mocha/npm/yarn/pnpm, `tsc`, package installs across the four major JS package managers). `bash-server.ts::tryStructuredSummary` falls back to `findSummarizer(command)` after the hardcoded branches, so new summarizers register without per-command edits.
- **`rawTotal` in stats** (v1.18) — new column in both `_stats.ts` (JSON) and `_stats-sqlite.ts` backends. Lets the dashboard display `saved / rawTotal` as a percentage. Backward-compat: missing values treat as 0. See section 3.

---

## 2a. GitHub OAuth + Cloud Genome Pipeline

As of v1.13, sign-in with GitHub triggers an auto-genome build for any public repo the user picks. The pipeline links the CLI, backend, and `ashlr__grep` retrieval path.

```
User runs /ashlr-upgrade
    │
    ▼
scripts/upgrade-flow.ts  ──► "Sign in with GitHub" picker
    │                         (magic-link preserved as fallback)
    ▼
browser: plugin.ashlr.ai/auth/github
    │  GitHub consent: read:user user:email public_repo
    ▼
server: /auth/github/callback
    │  AES-256-GCM encrypt token → users.github_access_token_encrypted
    │  write pending_auth_tokens by session_id
    ▼
CLI polls /auth/status?session=<sid>  ──► receives token
    │
    ▼
browser: /repo-picker
    │  POST /genome/build → fire-and-forget buildGenomeFromGitHub()
    │      git clone --depth 1 + genome-init --minimal
    │      per-section AES-GCM encrypt → upsertSection
    ▼
hooks/session-start.ts
    │  scripts/genome-cloud-pull.ts
    │      parse cwd git remote → canonicalize repo URL
    │      GET /genome/personal/find?repo_url=<canon>
    │      download sections → ~/.ashlr/genomes/<projectHash>/
    │      write .ashlr-cloud-genome marker
    ▼
ashlr__grep
    ├─ local .ashlrcode/genome/   (wins if present)
    ├─ ~/.ashlr/genomes/<hash>/   (cloud fallback via findParentGenome)
    └─ ripgrep full-tree          (last resort)
```

Full walkthrough: [docs/github-oauth-onboarding.md](github-oauth-onboarding.md)
Pipeline architecture: [docs/cloud-genome.md](cloud-genome.md)

---

## 3. Stats Data Flow

### Per-session bucket shape

`~/.ashlr/stats.json` holds a `sessions` map keyed by `CLAUDE_SESSION_ID` (or a PPID-derived fallback when the env var is absent). Each bucket:

```
sessions: {
  "<session-id>": {
    calls:        number,   // tool invocations attributed to this session
    tokensSaved:  number,
    costSaved:    number,
    startedAt:    ISO-string,
    byTool:       { [toolName]: { calls, tokensSaved, costSaved } },
    projects:     { [cwd]: { calls, tokensSaved } },
  }
}
```

Lifetime totals live in `stats.lifetime` alongside the map and are never dropped.

### Write path

```
MCP tool handler (e.g. ashlr__read)
  └─ recordSaving(tokens, cost, tool, cwd)   servers/_stats.ts:recordSaving
       └─ withSerializedWrite(fn)            in-process Promise mutex (writeQueue chain)
            └─ acquireLock()                 ~/.ashlr/stats.lock (O_EXCL, 200ms spin)
                 └─ readStats()              JSON.parse(readFileSync)
                      └─ mutate bucket
                           └─ writeStatsAtomic()
                                └─ writeFile(tmpPath)
                                     └─ fsync(fd)          (via Bun's native fd)
                                          └─ rename(tmp → stats.json)
                                               └─ releaseLock()
```

Two serialization layers — the in-process mutex (a chained Promise) prevents concurrent async calls within one server process from racing; the filesystem lock extends that to the router processes (one per open host session), hooks, and CLI scripts that can run simultaneously. The rename is atomic at the OS level, so readers never see a partial write.

### schemaVersion and migration

`stats.json` carries `"schemaVersion": 2`. On load, `_stats.ts:readStats` checks the version and migrates forward if needed (v1 had a single global `session` field; v2 moves that to the per-session map). The migration is additive and non-destructive — old lifetime counters are preserved.

---

## 4. Hook Graph

Claude Code hooks are declared in `hooks/hooks.json`; Codex reads its own set from `hooks/codex-hooks.json` (see the [README hook table](../README.md#hooks)). Every command runs through `scripts/hook-bootstrap.mjs`, which launches the TypeScript hook under Bun. The graph below lists every Claude Code hook registered today, grouped by event.

```
Session opens
    │
    ▼
SessionStart  (one --group entry)
    ├──► hooks/session-start.ts              (baseline scan as additionalContext,
    │                                         initSessionBucket(), team genome pull,
    │                                         once-per-day notice on stderr)
    ├──► hooks/sessionstart-brief.ts          (active ashlr-brief ruleset)
    └──► hooks/sessionstart-{search,lean-tools,genome-author,cost-refactor,efficient}.ts
                                              (each skill's ruleset, when enabled in
                                               ~/.ashlr/<skill>.json or .ashlr/<skill>.json)
    │
    ▼  (each prompt)
UserPromptSubmit ──► hooks/userpromptsubmit-brief-trigger.ts  (toggles brief mode on phrases
                                                                such as "be brief")
    │
    ▼  (each tool call; Claude Code fires only the entries whose matcher fits)
PreToolUse
    ├──► (no matcher)  hooks/pretooluse-budget-guard.ts   (warns at 80% and 95% of
    │                                                      ASHLR_SESSION_BUDGET_*, blocks at 100%)
    ├──► Edit|Write|Bash|MultiEdit|ashlr edit tools
    │                  hooks/policy-enforce.ts            (Pro policy pack; no-op without
    │                                                      ASHLR_PRO_TOKEN)
    ├──► Read          hooks/pretooluse-read.ts          ┐ redirect to ashlr__read, grep,
    ├──► Grep          hooks/pretooluse-grep.ts          │ edit, write, notebook_edit,
    ├──► Edit|Write|MultiEdit  hooks/pretooluse-edit.ts  │ websearch, task_list or task_get
    ├──► Write         hooks/pretooluse-write.ts         │ with permissionDecision "deny" when
    ├──► NotebookEdit  hooks/pretooluse-notebookedit.ts  │ ASHLR_HOOK_MODE=redirect
    ├──► WebSearch     hooks/pretooluse-websearch.ts     │ (the default)
    ├──► TaskList|TaskGet  hooks/pretooluse-task.ts      ┘
    ├──► Bash          hooks/commit-attribution.ts        (Assisted-By trailer on git commit -m)
    │                  hooks/pretooluse-bash.ts           (nudge only, never blocks)
    ├──► Glob          hooks/pretooluse-glob.ts           (nudge only, never blocks)
    ├──► WebFetch      hooks/pretooluse-webfetch.ts       (nudge only, never blocks)
    └──► Task          hooks/pretooluse-eco-router.ts     (ASHLR_ECO=1: question-shaped Task
                                                           calls go to ashlr:ashlr:explore)
    │
    │   Redirect safety nets: paths outside cwd (realpath-canonicalized, so macOS
    │   /tmp → /private/tmp), paths inside CLAUDE_PLUGIN_ROOT and bypassSummary:true
    │   are never redirected. Escape hatch: ASHLR_HOOK_MODE=nudge, or
    │   hookMode:"nudge" in ~/.ashlr/config.json.
    ▼
  [ tool executes ]
    │
    ▼
PostToolUse  (one --group entry; each hook keeps its own --match filter)
    ├──► hooks/post-tool-use-embedding.ts     (re-embed files changed by ashlr edit tools)
    ├──► hooks/audit-upload.ts                (Pro audit log; no-op without ASHLR_PRO_TOKEN)
    ├──► hooks/edit-batching-nudge.ts         (suggest batching repeated edits)
    ├──► hooks/genome-scribe-hook.ts          (nudge to propose significant edits)
    ├──► hooks/posttooluse-genome-refresh.ts  (queue edited paths for genome refresh)
    ├──► hooks/orient-nudge-hook.ts           (3+ reads or greps without an edit: suggest
    │                                          ashlr__orient)
    ├──► hooks/posttooluse-native-nudge.ts    (missed-save nudge after a native call that
    │                                          an ashlr tool could have served)
    ├──► hooks/post-tool-use-genome.ts        (feed scripts/genome-auto-propose.ts)
    ├──► hooks/session-log-append.ts          (JSONL append)
    ├──► hooks/pulse-emit.ts                  (OTLP span; no-op unless
    │                                          ASHLR_PULSE_OTLP_ENDPOINT is set)
    ├──► hooks/posttooluse-stale-result.ts    (track read and grep results for staleness)
    └──► hooks/posttooluse-dedupe-output.ts   (elide repeated read and grep output)
    │
    ▼  (end of each sub-agent, end of each assistant turn)
SubagentStop ──► hooks/subagent-stop-rollup.ts   (sub-agent savings rollup, genome consolidation)
Stop         ──► hooks/stop-accounting.ts        (turn accounting, idempotent with SessionEnd)
    │
    ▼
SessionEnd
    ├──► hooks/session-end-consolidate.ts  (genome consolidation; v1.17+ fires
    │                                       scripts/genome-cloud-push.ts afterwards
    │                                       when .cloud-id present)
    └──► hooks/session-end-stats-gc.ts     (drop session bucket, append summary to log)
```

PreToolUse hooks are matcher-filtered: Claude Code fires an entry only for the tools its matcher names. The budget guard has no matcher, so it sees every call. SessionStart and PostToolUse each have one entry that runs `scripts/hook-bootstrap.mjs --group`: a single node launcher starts every hook for the event as its own `bun` process, in parallel, and merges their output. In PostToolUse a `--match` before a hook keeps that hook's own tool filter, and the entry's matcher is the union of them. PostToolUse has a pipe-separated matcher covering both native tools and the ashlr MCP variants (canonical prefix `mcp__plugin_ashlr_ashlr__ashlr__*` as of v1.13 router consolidation; all matchers in `hooks/hooks.json` renamed to this form in v1.18 after legacy `mcp__ashlr-efficiency__*` / `mcp__ashlr-multi-edit__*` stopped matching post-router-migration). The [Automatic hooks](https://plugin.ashlr.ai/docs/concepts/hooks) page describes SubagentStop and Stop in more detail.

---

## 5. Genome Lifecycle

The genome is a per-project knowledge base stored under `.ashlrcode/genome/`. It powers genome-aware `ashlr__grep` routing and surfaces architectural context during sessions.

**Init** — `scripts/genome-init.ts` (invoked by the `/ashlr-genome-init` slash command). Creates the scaffold via `@ashlr/core-efficiency/genome:initGenome`, then writes three knowledge files: `knowledge/architecture.md` (baseline scanner output), `knowledge/conventions.md` (detected from config files), and `knowledge/decisions.md` (ADR-0000 placeholder).

**Propose (edit-triggered)** — the registered `hooks/genome-scribe-hook.ts` nudges the agent to call `ashlr__genome_propose` after significant Edit or `ashlr__edit` changes. It does not append proposals itself. Codex instead registers `hooks/post-tool-use-genome.ts` to send matched tool results to `scripts/genome-auto-propose.ts`, which can append to `proposals.jsonl`.

**Consolidate (Claude SessionEnd, Codex PreCompact)** — `hooks/session-end-consolidate.ts` invokes `scripts/genome-auto-consolidate.ts`, then attempts team-cloud push and incremental refresh. The automatic consolidator drains `proposals.jsonl` when at least three proposals are pending and logs to `~/.ashlr/genome-consolidation.log`. The MCP `ashlr__genome_consolidate` tool uses the separate core-efficiency queue at `evolution/pending.jsonl`; these are different paths.

---

## 6. Status Line Rendering

Claude Code calls the `statusLine.command` from its settings periodically and renders the first stdout line in its UI bar.

Pipeline:

```
stats.json
    └─ readCurrentSession(sessionId)        servers/_stats.ts
         └─ buildStatusLine()               scripts/savings-status-line.ts
              ├─ formatTokens(saved)        → "1.2K", "450K", "2.1M"
              ├─ readDailyHistory()         → last-N-day savings array
              ├─ renderSparkline(history)   scripts/ui-animation.ts:renderSparkline
              │    └─ 16-rung Unicode bars (ASCII fallback for non-Unicode terminals)
              ├─ renderGradient(sparkline)  scripts/ui-animation.ts:renderGradient
              │    └─ truecolor sweep (single brand color fallback)
              ├─ renderHeartbeat(pulse)     scripts/ui-animation.ts
              └─ applyColor(line)           scripts/savings-status-line.ts
```

**Capability detection.** `scripts/savings-status-line.ts` reads terminal capability flags before rendering. Unicode glyphs are suppressed when the terminal can't display them. Color is suppressed when `NO_COLOR` is set or when the terminal reports no color support. Animation is suppressed when `ASHLR_STATUS_ANIMATE=0`.

**Width budget.** The output target is 80 characters. `visibleWidth()` in `scripts/ui-animation.ts:visibleWidth` strips ANSI escapes and counts code points to measure rendered width, independent of color sequences. The status line truncates segments to stay within budget.

**Context-pressure widget.** A micro-widget `ctx: NN%` is inserted between the sparkline and the `session +N` segment when Claude Code pipes a session-state JSON payload on stdin. The widget is hidden entirely when the payload is absent or contains no usable fields — it never guesses. Color tiers (truecolor only):

| Range  | Color               |
|--------|---------------------|
| 0–60%  | dim brand-green     |
| 60–80% | yellow (`#d4a72c`)  |
| 80–95% | orange (`#d9793a`)  |
| 95%+   | red + bold (`#e15b5b`) |

Payload fields tried (in priority order):
1. `context_used_tokens` + `context_limit_tokens` (explicit used/limit pair — most precise)
2. All other fields (`input_tokens`, `context_tokens`, `total_tokens`, `total_tokens_used`, `sessionTokens`) require a paired limit field to compute a percentage; without one the widget is hidden.

The stdin reader in `import.meta.main` has a hard 50ms deadline and never blocks the terminal. The widget counts toward the 80-char visible-width budget. Drop-order under tight budget: tip is dropped first, then the context widget; the brand + session + lifetime core is never truncated mid-word.

**Settings toggles** (under `ashlr` key in `~/.claude/settings.json`):
- `statusLine` — master on/off switch (default: true)
- `statusLineSession` — show "session +N" segment
- `statusLineLifetime` — show "lifetime +N" segment
- `statusLineTips` — rotate a helpful tip at the tail

---

## 7. Session Log

`~/.ashlr/session-log.jsonl` is an append-only JSONL file. Each line is a flat JSON record.

**Append path** — `hooks/session-log-append.ts` fires PostToolUse through the grouped launcher. It parses the hook payload under Bun and appends a structured record. At 10 MB it rotates the log to `.1`, preserving the previous rotation as `.2`; `ASHLR_SESSION_LOG=0` disables it.

**Record schema:**
```json
{ "ts": "ISO-8601", "agent": "claude-code", "event": "tool_call",
  "tool": "ashlr__read", "cwd": "/abs/path", "session": "sess-id",
  "input_size": 42, "output_size": 310 }
```

**Session-end summary** — `hooks/session-end-stats-gc.ts` appends one final record per session with `event: "session_end"` carrying `calls`, `tokens_saved`, and `started_at` from the bucket being dropped.

**Planned events** — `tool_fallback` (LLM summarization fell back to snip-compact) and `tool_escalate` (agent escalated from haiku to sonnet) are reserved event types.

**Aggregator**: `scripts/session-log-report.ts` reads the log (+ rotated `.1`) and produces a plain-text report covering top tools by call count, per-project breakdowns, 24h vs lifetime comparison, and recent session summaries. Exposed via `/ashlr-dashboard --by-tool`.

---

## 8. Summarization

Sources: `servers/_summarize.ts` (prompts and public exports) and `servers/_llm-providers/index.ts` (dispatcher and cache).

**When it fires.** Tools call `summarizeIfLarge(content, options)` with a per-tool prompt. The helper's default threshold is 16,384 bytes; callers can override it, and read/grep tuning can adjust it. Read compaction and AST selection are separate paths, so a compact result does not necessarily imply an LLM call.

**Provider selection.** `ASHLR_LLM_PROVIDER=auto` tries an explicitly configured local endpoint first when `ASHLR_LLM_URL` is set, then Anthropic, the Pro cloud proxy, ONNX, and the local provider. It uses the first available provider. Set `ASHLR_LLM_PROVIDER=local` to select LM Studio/Ollama, or `off` to disable LLM summarization. The local plugin has no account requirement and telemetry is off by default.

**Cache.** SHA-256 of the input is used as cache key. Cache files live at `~/.ashlr/summary-cache/<hash>.txt` with a 1-hour TTL. A cache hit costs zero tokens.

**Fallback.** If the selected provider fails or no provider is available, summarization falls back to truncation and appends an LLM fallback note so the agent can see what happened. `bypassSummary: true` skips the summarizer. For `ashlr__read`, it also skips the whole-file cache and AST path and returns full content, with line numbers and accounting notes where applicable. Read ranges (`startLine` and optional `endLine`) return only the selected numbered lines without summarization or whole-file caching.

**Per-tool prompts.** `_summarize.ts:PROMPTS` contains system prompts tuned for each output type. The read prompt asks for a one-sentence purpose, top-level export names, and verbatim annotations and marked warnings with line numbers; bash preserves errors and exit codes; SQL preserves first and last rows, column types, and total row count.

---

## 9. Adding a New MCP Tool

With the consolidated router, adding a tool needs no new `mcpServers` entry in `plugin.json`. The same steps are on the site at [Contributing: Architecture](https://plugin.ashlr.ai/docs/contributing/architecture).

1. **Write the handler** in a focused `servers/<name>-server-handlers.ts` module (see `servers/glob-server-handlers.ts`):
   - Import `registerTool` from `servers/_tool-base.ts` and call `registerTool({ name: "ashlr__foo", description, inputSchema, handler })` at module top level.
   - When the tool shortens output, call `recordSaving(rawBytes, compactBytes, "ashlr__foo")` from `servers/_stats.ts`. Use `logEvent` from `servers/_events.ts` for session log entries.
   - Return `{ content: [...], isError: true }` for expected failures. The router's dispatch boundary also catches anything the handler throws.

2. **Import the module from `servers/_router-handlers.ts`.** The CLI, smoke test and catalog generator load handlers through this file.

3. **Run `bun run references:sync`.** It regenerates `servers/_tool-catalog.json`, updates the tool counts in the docs, README and `scripts/smoke-tools.ts`, and refreshes the generated site pages. Without it the router never lists the tool, because `tools/list` reads only the catalog. Leave a regenerated `site/lib/docs.generated.json` out of the commit (see [AGENTS.md](../AGENTS.md#hot-files)).

4. **Write tests in `__tests__/foo-server.test.ts`.** Use `mkdtemp` for an isolated `HOME` so no test touches `~/.ashlr`. To test over the wire, spawn the real server process and speak JSON-RPC over stdio (see the `rpc()` helper in `__tests__/efficiency-server.test.ts`). Then run `bun run references:check` and `bun run smoke:tools`.

5. **Add to `CHANGELOG.md`** under `## [Unreleased]`, and add a row to the tool registry table in section 2.

The entrypoint script handles `bun install` automatically for users.

---

## 10. Testing Model

Test runner: Bun's built-in runner. Plugin tests live in `__tests__/`; the end-to-end suite in `integration/` and the Pro backend in `server/` have their own dependencies and tests. The full guide is [Contributing: Testing](https://plugin.ashlr.ai/docs/contributing/testing).

**Isolation.** Every test suite that touches the filesystem creates a `mkdtemp` temp dir and passes it as `HOME` (or equivalent) to the code under test. No test reads or writes the real `~/.ashlr`. See `__tests__/session-log-report.test.ts:beforeEach` for the canonical pattern.

**Server tests over stdio.** `__tests__/efficiency-server.test.ts` spawns the real MCP server process and sends JSON-RPC requests over stdio. This catches wiring bugs that unit tests miss. The `rpc(reqs, cwd)` helper in that file is a reusable pattern for other server tests.

**Fixture conventions.** Synthetic log/stats data is built inline as arrays of typed records, not from files on disk. This keeps tests hermetic and readable without fixture file management.

**Special test groups:**
- `__tests__/integration/` — multi-module scenarios (genome to grep, content cache) that still run in the root suite.
- `__tests__/quality/` — fidelity and regression checks for `ashlr__read` and `ashlr__grep` output.
- `integration/` — end-to-end flows that spawn real MCP server processes and the backend in a temp `HOME`.

**Running:**
```
bun run test                                  # whole root suite via scripts/run-root-tests.ts
bun test __tests__/foo.test.ts                # single file
cd integration && bun test --timeout 30000    # end-to-end suite (run `bun install` there first)
```

Use `bun run test`, not plain `bun test`, for the whole suite. The wrapper prepares the derived docs some tests read, runs files in isolated workers, and checks that every test file reported back.

Postgres tests in `__tests__/sql-server.test.ts` run only when `$TEST_DATABASE_URL` is set.

---

## 11. Release Flow

Releases are automated; nobody publishes from a laptop. The full walkthrough is [Contributing: Releases](https://plugin.ashlr.ai/docs/contributing/releases).

1. Move the `## [Unreleased]` notes in `CHANGELOG.md` into a dated `## [X.Y.Z] - YYYY-MM-DD` section.
2. Run `bun run version:bump X.Y.Z`. It writes `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and touches nothing in git. `bun run version:check` enforces that they agree on every PR.
3. Run `bun run fresh:sync` and `bun run site/scripts/gen-docs.ts` to refresh derived release facts, then open a PR and merge it.
4. After the merge, `.github/workflows/auto-tag.yml` creates the `vX.Y.Z` tag once the commit's required checks are green, and starts `.github/workflows/release.yml`. That workflow requires a full `ci.yml` run on the exact tag (Linux, macOS and Windows), creates the GitHub release, and publishes to npm through trusted publishing.

The release gate is described in [release-qualification.md](release-qualification.md). On startup, `scripts/mcp-entrypoint.ts` treats its own versioned cache directory name as the current version and removes stale sibling version directories next to it.

---

## 12. Design Principles

These are the non-obvious decisions baked into the codebase.

**Summarization follows the user's credentials; telemetry is opt-in.** With the default `ASHLR_LLM_PROVIDER=auto`, output above the threshold goes to the first available provider: an explicit `ASHLR_LLM_URL`, then Anthropic (`ANTHROPIC_API_KEY` or a Claude Code login), the hosted Pro summarizer, in-process ONNX, and the local endpoint at `127.0.0.1:1234`. `ASHLR_LLM_PROVIDER=local`, `onnx` or `off` keeps summaries on the machine; see [llm-providers.md](llm-providers.md#where-file-contents-go). Telemetry is off by default and has to be enabled separately.

**Atomic stats writes.** A two-layer write protocol (in-process Promise chain + `O_EXCL` lockfile + `rename`) ensures that N concurrent MCP servers and hooks never corrupt `stats.json`. Any approach that just does `JSON.parse` → mutate → `writeFile` will lose updates under load. The lockfile spin is capped at 200ms; if it can't acquire, it skips the write rather than blocking the tool call.

**Per-session accounting.** The old `stats.json` had a single global `session` field. With multiple Claude Code terminals open, every server clobbered each other's counter. v2 uses `CLAUDE_SESSION_ID` as a bucket key. The TypeScript MCP entrypoint mirrors this value to `ASHLR_SESSION_ID` before launching the router.

**Width-stable status line.** The status line must not reflow the UI on every refresh. `visibleWidth()` strips ANSI escapes before measuring. Segments are truncated (not wrapped) to stay within 80 chars. The sparkline always occupies the same number of columns regardless of savings magnitude.

**Genome is fire-and-forget.** The auto-propose hook, the consolidation hook, and the genome server are all written to never throw and never block the agent. A genome write failure is invisible to the user. This is intentional — genome is an optimization layer, not a correctness requirement.

**GC at session end.** Per-session buckets are dropped from `stats.json` when the session closes (`hooks/session-end-stats-gc.ts`). Lifetime counters are never dropped. This bounds `stats.json` size without losing the numbers that matter.

---

## Generated references

After changing tool schemas, descriptions, commands or other product facts, run `bun run references:sync` from the repository root. It regenerates the live tool catalog, synchronizes default tool counts, then refreshes site facts and references in that order. Use `bun run references:check` to validate the same outputs without rewriting files. The sync command also regenerates the local site corpus (`site/lib/docs.generated.json`); follow the `AGENTS.md` hot-file rule and leave it out of the PR. Because the committed corpus is not kept current, `references:check` reports it as stale whenever the checkout holds the committed copy, as a fresh clone does. That line is expected; any other line is real drift.

## Supported Platforms

ashlr-plugin is tested in CI on three operating systems in `.github/workflows/ci.yml`. Pull requests, merge-queue entries and pushes to `main` run the seconds-fast `fast` gate (version sync, plus install, typecheck and a site release-facts check for code changes) and the `Secret-shape scan`; `CI Gate` is the single required check. A diff that touches OS-sensitive paths also runs affected checks and an install smoke on Windows and macOS. Those jobs are not in `CI Gate`'s needs. The full suite — typecheck, unit tests and smoke on Linux, macOS and Windows, the server, site and VS Code checks, the `integration/` suite and a Windows MCP smoke test — runs on the daily schedule and on `workflow_dispatch` with the default `validation_scope=full`. A `windows-diagnostics` dispatch runs only a bounded Windows diagnosis (`scripts/windows-release-diagnostics.ts`) and never qualifies a release. The benchmark refresh job in `ci.yml` runs on the daily schedule only; the separate `bench.yml` workflow also runs after each merge to `main`. None of these post-merge runs is a required check.

| Platform | Runner | Status |
|---|---|---|
| Linux | `ubuntu-latest` | Full support |
| macOS | `macos-latest` | Full support |
| Windows | `windows-latest` | Full support — see caveats below |

### Caveats

**ripgrep install.** The install step is platform-specific: `apt-get` on Linux, `brew` on macOS, `choco` on Windows (`winget` needs a store source agreement that breaks in CI). The plugin itself does not bundle ripgrep; it must be on `PATH`.

**File permissions.** Three permission tests are skipped on Windows with `test.skipIf(process.platform === "win32")` because Windows does not honour POSIX `chmod` mode bits. A few POSIX-only process and shell cases are skipped too; [platform-support.md](platform-support.md#tests-skipped-on-windows) lists them all:
- `genome-crypto.test.ts` — key file mode 0600 check
- `genome-init.test.ts` — unreadable dir (chmod 000) fallback
- `doctor.test.ts` — non-executable hook warnings / chmod +x fix

**`ashlr__bash`.** `resolveShell()` in `servers/bash-server.ts` runs commands with `$SHELL -c` (falling back to `/bin/sh`) on POSIX and with PowerShell (`pwsh`, falling back to `powershell`) and `-Command` on Windows, so Windows commands must be PowerShell syntax. On POSIX, v1.18 spawns with `detached: true` and kills the process group (`-pid`) on timeout so forked grandchildren (`npm install`, `cargo build`) don't leak past the timeout. Policy-enforce cache path uses `os.tmpdir()` (v1.18) so the hook works on Windows.

**CRLF line endings.** The checkout step sets `core.autocrlf false` in all matrix jobs to prevent git from converting LF to CRLF on Windows, which would break hash-based cache keys and diff expectations.

**Integration tests.** The `integration/` suite runs as a step inside the `linux checks` job. These tests spawn the backend server process; the server is deployed on Linux in production, so Linux e2e parity is sufficient. On Windows, the `integration-windows` job boots the MCP entrypoint and checks that `ashlr__read`, `ashlr__grep` and `ashlr__savings` answer. See `docs/platform-support.md` for the full matrix of what runs where.
