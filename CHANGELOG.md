# Changelog

All notable changes to ashlr-plugin. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.6.0] — 2026-04-15

**Real summarization, not just truncation.** Six MCP tools now route large output through the local LLM (LM Studio default; cloud-override via env). Plus four UX fixes that came out of running the v0.5.0 install live.

### Added
- **`servers/_summarize.ts`** — shared LLM-summarization helper. Local-first (`http://localhost:1234/v1` default), 5s timeout with snipCompact fallback, 1-hour SHA-256 cache at `~/.ashlr/summary-cache/`, per-tool prompts, optional cloud override via `ASHLR_LLM_URL` + `ASHLR_LLM_KEY`. Cloud only fires when explicitly opted into — preserves the no-account positioning.
- **Summarization wired into 6 tools**: `ashlr__read`, `ashlr__grep` (rg-fallback path only), `ashlr__edit`'s sibling tools, `ashlr__diff` (summary/full modes), `ashlr__logs`, `ashlr__bash` (raw pass-through path), `ashlr__sql` (>100 row results). Each tool got a `bypassSummary: boolean` input field. Tools that DON'T summarize: tree, http, genome ops, savings, bash control-plane (start/tail/stop/list).
- **Stale plugin cache cleanup** in `hooks/session-start.ts` — prevents the v0.3.0 stale-cache bug we hit live. Removes sibling versioned dirs that aren't the current `${CLAUDE_PLUGIN_ROOT}`. Strict semver guard so non-version dirs (`latest`, `dev-branch`, etc.) survive untouched.
- **`docs/install.sh`** pre-clean step — removes older versioned cache dirs at install time, keeps only the latest semver via `sort -V`.
- **`docs/install-prompt.md`** rewrite — single bulletproof paste-block that walks Claude Code through the full install + restart + verify + (optional) genome init + tour, reporting at each step.

### Fixed
- **`commands/ashlr-benchmark.md`** — replaced hardcoded `~/.claude/plugins/ashlr-plugin/...` fallback with `${CLAUDE_PLUGIN_ROOT}/...` and a clear error if the env var isn't set. Fixes the `/0.3.0/` stale-path symptom.
- **Status-line tip truncation** (`scripts/savings-status-line.ts`) — now reads `$COLUMNS` (capped at 120, falls back to 80), only renders the tip when ≥15 chars of budget remain (no more `tip: a…`), and shortened the longest tip from 47→38 chars.

### Changed
- **Activation notice** in `hooks/session-start.ts` updated from "v0.3.0 active — 5 tools" to "v0.6.0 active — 9 MCP tools incl. summarization."
- **Hero animation** rebuilt: 4 tool calls (Read, Grep, Edit, Bash), faster counter rise on the "Without ashlr" side, italic Fraunces stamp-rotate-in for the final `−84%`, oxblood-tinted underline pulse on the loser column + eucalyptus-tinted on the winner, plus a `$X.XX saved` badge that fades in after the stamp.

### Tests
- **216 pass, 1 skip, 0 fail** across 18 files (was 187 in v0.5.0).
- 8 new tests in `__tests__/_summarize.test.ts` covering threshold, cache hit, LLM unreachable fallback, malformed response, bypass mode, stats accounting.
- 4 new wiring tests across efficiency/diff/logs/bash/sql servers.
- 6 new tests in `__tests__/session-start-cleanup.test.ts`.
- 3 new status-line tip-budget tests.


## [0.3.0] — 2026-04-15

**Beyond parity.** Three new MCP servers (SQL, Bash, baseline scanner) make ashlr strictly more useful than WOZCODE on database work, shell work, and session orientation. 94/94 tests pass.

### Added

- **`ashlr__sql` tool** (`servers/sql-server.ts`) — compact SQL execution in one tool call.
  - SQLite (built-in via `bun:sqlite`) + Postgres (via `postgres` npm package, 3.4.9)
  - Auto-detects connection: explicit arg → `$DATABASE_URL` → `*.db` / `*.sqlite` in cwd (most-recently-modified wins)
  - Password redaction in every output header line
  - `explain: true` returns the query plan only
  - `schema: true` introspects tables + columns + row counts (cheaper than many `\d` / `SHOW TABLES`)
  - `limit` caps returned rows, reports elision count
  - CSV-baseline savings math (RFC 4180 quoting) — example: 142 rows × 4 cols = 10,812-byte CSV baseline → 1,730-byte compact table → **~2,271 tokens saved per query**
  - 13 integration tests (SQLite in-memory, file, schema, EXPLAIN, errors, redaction, elision); postgres live test gated on `$TEST_DATABASE_URL`
- **`ashlr__bash` tool** (`servers/bash-server.ts`) — shell with auto-compressed output.
  - `snipCompact` on stdout > 2KB (800-byte head + 800-byte tail; stack traces and exit messages survive)
  - **stderr never compressed** — errors reach the agent intact
  - Recognized commands get structured summaries instead of raw output:
    - `git status` → `M: 3, A: 1, ??: 2 · branch main · ahead 2 of origin/main`
    - `ls` / `find` → elide middle on > 40 / > 100 entries
    - `ps aux` → filter to rows matching cwd-name when > 100 rows
    - `npm ls` / `bun pm ls` → dedupe warnings, collapse tree depth > 2
    - `cat <file>` → refused with redirect to `ashlr__read`
  - Refuses catastrophic patterns (`rm -rf /`) with a clear message
  - 60s default timeout; SIGKILL on expiry
  - Concrete savings: `head -c 10240 /dev/zero | tr` → 10,240 → 1,660 bytes → ~2,145 tokens saved
  - 9 integration tests
- **Baseline scanner** (`scripts/baseline-scan.ts` + `hooks/session-start.ts`) — pre-scans the project at `SessionStart` and pipes the baseline into the agent's system prompt as `additionalContext`.
  - One-screen output: file counts by extension, entry points, largest source files, test layout, genome detection, git state (branch, uncommitted, ahead/behind, last commit), runtime fingerprint
  - Uses `git ls-files` for free gitignore handling (fallback: `readdir` with a hardcoded exclusion list)
  - Hash-cached at `~/.ashlr/baselines/<sha>.json`; invalidates when probed mtimes exceed cache, or after 24h
  - Hard cap 5,000 files (emits `truncated: true` above)
  - Replaces `hooks/session-start.sh`; the `.sh` is now superseded (left for reference)
  - 15 tests

### Fixed

- (none — v0.2.0 stayed solid; v0.3 is pure addition)

### Changed

- `.mcp.json` now registers **three** MCP servers (`ashlr-efficiency`, `ashlr-sql`, `ashlr-bash`). Claude Code launches them independently.
- `hooks/hooks.json` `SessionStart` now points at `session-start.ts` (which invokes the baseline scanner).

### Feature comparison vs WOZCODE

Now strictly ahead on the core value prop:
- ✅ Tri-agent, Read/Grep/Edit, tool-redirect, commit attribution, edit-batching, status line, savings tracker, settings, `/recall`, `/update`, `/benchmark`
- ✅ **SQL tool** (WOZCODE claims 10× on DB tasks — ours is open-source + explain + schema + auto-detect)
- ✅ **Bash tool** (our own, with structured summaries)
- ✅ **Baseline scanner** (ours is cached + git-aware)

Still intentional non-goals (ethical wins preserved):
- No account, no login
- Zero telemetry (WOZCODE has PostHog baked into `.mcp.json`)
- MIT open source
- Shared `@ashlr/core-efficiency` library, also used by standalone CLI

### Tests

**94 pass, 1 skip, 0 fail** across 8 files:
- 11 · MCP efficiency-server end-to-end
- 12 · tool-redirect hook
- 14 · commit-attribution hook
- 13 · savings-status-line
- 7 · edit-batching-nudge
- 13 · sql-server (+1 postgres-live, skipped without `$TEST_DATABASE_URL`)
- 9 · bash-server
- 15 · baseline-scan

## [0.2.0] — 2026-04-15

WOZCODE feature-parity release. Four hooks (tool-redirect, commit-attribution, edit-batching-nudge, session-start) + status-line integration + three new slash commands (`/ashlr-recall`, `/ashlr-update`, `/ashlr-benchmark`). Fixed `.mcp.json` to use `${CLAUDE_PLUGIN_ROOT}`. `ashlr__edit` now actually applies edits. 57 tests.

## [0.1.0] — 2026-04-15

Initial public release. MCP server with 4 tools, 3 agents, 3 slash commands, session-start hook, benchmark harness, landing page at `plugin.ashlr.ai`, CI, publish script. Shared `@ashlr/core-efficiency` library architecture. MIT.
