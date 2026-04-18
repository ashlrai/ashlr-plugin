# Changelog

All notable changes to ashlr-plugin. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.9.2] — 2026-04-17

**Polish release** — code-review + simplifier + security audit on the v0.9.x work. Seven real findings, all fixed. No feature changes.

### Fixed

- **SSRF via redirect bypass** (`servers/_http-helpers.ts`, `servers/webfetch-server.ts`, `servers/http-server.ts`). `fetch({ redirect: "follow" })` silently followed 3xx hops without re-checking the target hostname — a public URL could redirect to `127.0.0.1` or `169.254.169.254` (cloud metadata) and bypass `isPrivateHost`. New `safeFetch()` helper implements manual redirect validation: every hop is re-checked against `isPrivateHost`, which now also covers `169.254.x` (link-local), `0.x`, and multicast ranges. Both MCP servers routed through `safeFetch` — any redirect to a private host throws with a clear hop-numbered error.
- **`ashlr__multi_edit` strict-mode `$` interpolation** (`servers/multi-edit-server.ts`). Used `String.prototype.replace(string, string)` which interprets `$&`, `$1`, `` $` ``, `$'` in the replacement — silently corrupting any edit whose replacement contained a `$` followed by certain chars (e.g. template literals, TypeScript generics, currency strings). Now uses `slice + concat` so the replacement is always literal. Non-strict mode was already safe via `split/join`.
- **Stats flush-on-exit race** (`servers/_stats.ts`). `flushToDisk` cleared `_pendingStats` on entry, so if the process exited mid-async-write the sync exit handler had nothing to flush even though the in-flight async rename might not have completed. Now `_pendingStats` is only cleared *after* the rename succeeds, so the sync path can always re-run an in-flight flush.
- **Status-line ANSI-unsafe truncation** (`scripts/savings-status-line.ts`). The last-resort over-budget truncation did `line.slice()` on a string that might contain ANSI escape sequences — a cut in the middle of `\x1b[38;2;…m` would leak a dangling escape that corrupts the terminal. Now strips ANSI before slicing.
- **Webfetch content-type precedence** (`servers/webfetch-server.ts`). Operator precedence on the HTML-sniffing heuristic meant JS/binary responses whose body happened to start with `<` were getting HTML-stripped. Parens fixed.
- **`confidenceBadge` zero-output tier** (`servers/_summarize.ts`). `rawBytes > 0 && outputBytes === 0` (total elision) used to return `"high"`; now correctly returns `"low"`.
- **Dashboard script cleanup** (`scripts/savings-dashboard.ts`). Removed unused `basename` import, dead `BANNER_LINES` array, and unused local in `boxTop()`. Simplifier pass.

### Security posture

Security audit also verified clean across: shell injection (bash-server uses `-c` with user command as single arg), input validation (all MCP handlers typeof-check args), secrets (no `ASHLR_LLM_KEY` logging), SQL (user-controlled by design), deserialization/prototype pollution, DoS caps (bash 5MB, webfetch 100KB default), hook payloads (validated).

### Tests

- **728 pass, 2 skip, 0 fail** across 45 files. No new tests (this release is bug fixes only, verified against the existing suite).

### Migration notes

- No breaking changes. `safeFetch` is a drop-in replacement for the internal `fetch` path; callers outside the plugin are unaffected.


## [0.9.1] — 2026-04-17

**Real-time counters, "↑" activity indicator, ASCII-art live dashboard.** Three polish wins that landed right after v0.9.0 shipped.

### Added

- **Activity indicator in the status line** (`scripts/ui-animation.ts` `activityIndicator()`). When a `recordSaving` fired in the last 4s, an `↑` glyph appears between the label and counter: `session ↑+12.3K`. Truecolor interpolates from brand-light (just saved) to brand-dark (fading). ASCII fallback renders `+` double-prefix. Width-stable across all states.
- **ASCII-art live dashboard** (`scripts/savings-dashboard.ts` — full rewrite). Three-part layout: a wordmark banner, a tile strip (session / lifetime / best day), per-tool horizontal bar chart, 7-day + 30-day sparklines, projected annual, top 3 projects. `--watch` mode clears the screen and redraws every 1.5s. Degrades cleanly under `NO_COLOR=1`.
- **Real-time cross-terminal freshness test** (`__tests__/stats-realtime.test.ts`). Proves terminal A's lifetime bump is visible to terminal B's status line within 500 ms, and that terminal A's session bump is NOT visible in terminal B (per-session invariant holds).
- **Smoke-test script** (`scripts/smoke-realtime.ts`). Runnable via `bun run scripts/smoke-realtime.ts` — records 10 savings at 100 ms intervals, asserts each shows up in the next status-line read within 500 ms. Manual QA harness for the real-time path.

### Fixed

- **Status-line read cache TTL reduced from 2 s → 300 ms** (`scripts/savings-status-line.ts`). Combined with the 250 ms write debounce, worst-case visible latency is now 550 ms (was ~2.25 s). The mtime-invalidation on the cache still short-circuits when another terminal writes, so typical freshness is ~250 ms.
- **Flush-on-exit hardening** (`servers/_stats.ts`). Confirmed via new tests that `beforeExit`/`exit` handlers synchronously flush any pending debounced delta — no session can lose its tail of savings.

### Tests

- **728 pass, 2 skip, 0 fail** across 45 files (+44 tests vs v0.9.0).

### Migration notes

- No breaking changes. Purely additive + one cache TTL tightening that's invisible to users except as faster counter updates.


## [0.9.0] — 2026-04-17

**Atomic batched edits, a meta-router tool, shareable savings badge, genome auto-refresh, confidence badges on every summarized output, and a context-pressure widget in the status line.** Six focused streams shipped in parallel — no breaking changes.

### Added

- **`ashlr__multi_edit`** (`servers/multi-edit-server.ts`) — atomic batched edits across N files in one roundtrip. Each edit is a path + search + replace + strict tuple. If any edit fails, every prior edit is rolled back using cached originals. Files are read once per path and written once per path after all edits succeed. Savings are recorded against the sum of original + updated lengths across all files — equivalent to N naive Edit calls.
- **`ashlr__ask`** (`servers/ask-server.ts`) — meta-router tool that accepts a natural-language question and routes deterministically (no LLM in the routing path) to the correct underlying ashlr tool: glob patterns → `ashlr__glob`, read verbs + path token → `ashlr__read`, grep verbs → `ashlr__grep`, structural questions → `ashlr__orient`, list/tree verbs → `ashlr__tree`. Fallback is `ashlr__orient`. Routing decision and extracted param are included in every response.
- **`/ashlr-badge` skill** (`commands/ashlr-badge.md` + `scripts/generate-badge.ts`) — generates a self-contained SVG stats card from `~/.ashlr/stats.json`. Three `--metric` modes (tokens / dollars / calls), three `--style` variants (flat / pill / card with mini bar chart), three `--window` modes (lifetime / last30 / last7). `--out <path>` writes to file; `--serve` starts a badge server on `:7777` so the badge auto-updates as tokens accumulate. Embeddable in GitHub profile READMEs.
- **`servers/_genome-live.ts`** — in-process genome auto-refresh after every `ashlr__edit`. Patches genome sections that embed edited content verbatim; invalidates (deletes) sections that only summarize the file so the propose queue regenerates them. Fire-and-forget (callers `.catch(()=>{})`), never throws, honors `ASHLR_GENOME_AUTO=0`, uses a per-file in-process mutex, and calls `_clearCache()` so the LRU evicts stale retrievals. Wired into `ashlr__edit` and `ashlr__multi_edit`.
- **`confidenceBadge`** (`servers/_summarize.ts`) — fidelity signal appended to every compressed output. Reports compression ratio and whether `bypassSummary:true` would recover the full payload. Call sites do `text + confidenceBadge({...})` — the function is side-effect-free and always returns a string.
- **Context-pressure widget** (`scripts/savings-status-line.ts` + `scripts/ui-animation.ts`) — reads the Claude Code context-fill percentage from the stdin payload and renders a color-tiered micro-widget (green / yellow / red) between the sparkline and the "session +N" counter. Hidden entirely when the value is absent or the terminal is too narrow.

### Tests

- **684 pass, 2 skip, 0 fail** across 43 files (was 554 pass across 38 files in v0.8.0 — **130 new tests** net).
- New test files: `__tests__/ask-server.test.ts`, `__tests__/confidence-badge.test.ts`, `__tests__/generate-badge.test.ts`, `__tests__/genome-live.test.ts`, `__tests__/multi-edit-server.test.ts`.
- Extended: `__tests__/efficiency-server.test.ts`, `__tests__/logs-server.test.ts`, `__tests__/savings-status-line.test.ts`, `__tests__/ui-animation.test.ts`.

### Migration notes

- No breaking changes. All new tools are additive; existing tool APIs are unchanged.
- Users should run `/reload-plugins` (or restart Claude Code) after upgrading to register `ashlr-multi-edit` and `ashlr-ask` as MCP servers.
- `_genome-live.ts` is wired automatically — no configuration required. Disable with `ASHLR_GENOME_AUTO=0`.

## [0.8.0] — 2026-04-17

**Truly per-session counters + truly zero permission prompts + two new MCP tools + an animated status line.** A single-session major push that makes the plugin honest, quiet, and delightful.

### Added

- **Per-session token accounting** (`servers/_stats.ts`, new). Shared source of truth keyed by `CLAUDE_SESSION_ID` with atomic temp+rename writes, cross-process file lock, in-process mutex, minified JSON, `schemaVersion: 2` with v1 migration, debounced batch flush (250ms; `ASHLR_STATS_SYNC=1` opts out), `lastSavingAt` field driving the animation pulse. All 12 MCP servers migrated from their own per-file `recordSaving` to delegate here. Fixes the bug where "session +N" in one terminal would clobber every other terminal's counter.
- **Animated status line** (`scripts/ui-animation.ts`, new). 16-rung Unicode ramp with ASCII fallback, truecolor gradient shimmer between `ashlr-brand-dark` → `ashlr-brand-light`, 4-second activity pulse after every `recordSaving`, 15-frame braille heartbeat glyph. Width-stable across 60 consecutive frames. `NO_COLOR=1` / `ASHLR_STATUS_ANIMATE=0` degrade cleanly.
- **`ashlr__glob`** (`servers/glob-server.ts`) — compressed glob-pattern matching. `git ls-files -z` when in a repo (`.gitignore`-aware for free); readdir walker fallback. Groups >20 matches by top-level directory.
- **`ashlr__webfetch`** (`servers/webfetch-server.ts`) — token-efficient wrapper around WebFetch. Extracts main content from HTML, pretty-prints + array-elides JSON, refuses private hosts. Shares `servers/_http-helpers.ts` with `ashlr__http`.
- **`/ashlr-allow` skill** (`commands/ashlr-allow.md` + `scripts/install-permissions.ts`) — one command that adds `mcp__ashlr-*` entries to `~/.claude/settings.json`'s `permissions.allow`, so Claude Code stops prompting on every ashlr tool call in `bypassPermissions` mode. Idempotent, atomic-write, supports `--dry-run` and `--remove`.
- **`/ashlr-usage` skill** (`commands/ashlr-usage.md` + `scripts/session-log-report.ts`) — reads `~/.ashlr/session-log.jsonl`, surfaces top tools, per-project breakdown, 24h-vs-lifetime split, session-end rollups, and fallback/escalation rates.
- **`/ashlr-errors` skill** (`commands/ashlr-errors.md` + `scripts/errors-report.ts`) — tails MCP server errors with signature-based deduplication (strips timestamps/UUIDs/paths), last-week window by default.
- **`/ashlr-demo` skill** (`commands/ashlr-demo.md` + `scripts/demo-run.ts`) — 30-second scripted showcase on the cwd repo (read + grep + totals).
- **Calibration harness** (`scripts/calibrate-grep.ts` + `scripts/read-calibration.ts`) — replaces the speculative `4×` grep baseline with an empirically measured multiplier. Opt-in via `ASHLR_CALIBRATE=1`; non-calibrating path unchanged.
- **Fallback/escalation event emission** (`servers/_events.ts`) — logs `tool_fallback`, `tool_escalate`, `tool_error`, `tool_noop` records to the session log with reason codes (`no-genome`, `llm-unreachable`, `nonzero-exit-elided`, etc.) so `/ashlr-usage` can show you when things routed away from the fast path.
- **Session-end GC hook** (`hooks/session-end-stats-gc.ts`) — drops the per-session bucket on SessionEnd and appends a final summary record to the session log. Prevents unbounded `sessions` map growth.
- **Per-session architecture doc** (`docs/architecture.md`) — 292-line contributor guide covering MCP server map, stats data flow, hook graph, genome lifecycle, status-line pipeline, summarization, how to add a new server, testing model, release flow, design principles. All `file:line` references verified.
- **Dashboard upgrade**: `ashlr__savings` now shows per-project breakdown, top-10 largest savings events (by tool × day), and a calibration confidence line.
- **Quality guardrails**: `ashlr__grep` genome path now also runs `rg -c` for a confidence estimate ("genome returned 2 sections · rg estimates 47 matches · pass bypassSummary:true for the full list"). `ashlr__bash` widens the tail to 4 KB on non-zero exits and warns loudly when the LLM summary is unavailable. `PROMPTS.read` now requires the summarizer to preserve every `@`-decorator, `TODO/FIXME/WARNING/THREAD-UNSAFE/DEPRECATED/NOTE/SAFETY` marker, and every `export`/`module.exports`/`__all__` statement.
- **Genome LRU** (`servers/_genome-cache.ts`) — 64-entry process-lifetime cache keyed by `(genomeRoot, pattern)` with manifest-mtime invalidation.
- **Permissions section** in `README.md` explaining `/ashlr-allow`.
- **172 new tests** across 13 new test files (stats, ui-animation, glob, webfetch, session-log-report, install-permissions, events-emit, genome-cache, calibrate-grep, errors-report, demo-run, render-savings-report, quality/read-fidelity, quality/grep-confidence). Plus extensions to doctor, efficiency, and savings-status-line tests.

### Fixed

- **Permission prompts in `bypassPermissions` mode.** `hooks/tool-redirect.ts` no longer returns `permissionDecision: "ask"` (which per the Claude Code docs is evaluated regardless of bypass mode). Now a silent nudge via `additionalContext` only — the agent still learns about `ashlr__*` alternatives, the user is no longer interrupted.
- **`hooks/pretooluse-{read,edit,grep}.sh` hard-blocks disabled by default.** Enforcement is now opt-in via `ASHLR_ENFORCE=1` (was opt-out via `ASHLR_NO_ENFORCE=1`; the old flag still honored). The soft nudge from `tool-redirect.ts` is sufficient in normal use.
- **Bash `snipBytes` tail widens to 4 KB on non-zero exits** so fatal errors never drop to elision. New `errorAware: true` path emits a loud warning when the LLM is unreachable: "an error may be in this gap".
- **`ashlr__edit` strict-mode race clarified** — unchanged behavior, documented in `docs/architecture.md`.

### Changed

- `scripts/mcp-entrypoint.sh` forwards `CLAUDE_SESSION_ID` into every MCP server env (also exports `ASHLR_SESSION_ID` as a mirror) so `recordSaving` can scope to the right bucket.
- `hooks/session-start.ts` now calls `initSessionBucket()` on every start — sets `startedAt` accurately for `/ashlr-savings`. No longer clobbers sibling terminals.
- `savings-status-line.ts` reads from `stats.sessions[<id>]` instead of the legacy global `session` field (v1 counter was always inaccurate across concurrent terminals).
- Status line ramp upgraded from 9 rungs to 16 rungs (mixed Braille + Unicode block chars) for smoother visual gradient.
- `scripts/publish.sh` now leaves the old enforcement flag honored and does not force-push.

### Tests

- **554 pass, 1 skip, 0 fail** across 38 files (was 287 pass across 24 files before this release — **267 new tests** net, not counting renames).

### Migration notes

- Existing `stats.json` files are automatically migrated to `schemaVersion: 2` on the next `recordSaving`. The legacy global `session` field is dropped (it was inaccurate across concurrent terminals anyway); lifetime totals are preserved unchanged.
- Users should run `/ashlr-allow` once to silence permission prompts. Restart Claude Code (or `/reload-plugins`) after upgrading.


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
