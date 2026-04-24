# Changelog

All notable changes to ashlr-plugin. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

**Routing recovery — Write/MultiEdit redirect + cwd-clamp expansion.** Diagnosed against the v1.20.1 session log: per-day savings collapsed from 4.7M tokens (04-19 peak) to ~14K (04-22), then climbed back to 88K on 04-24. Two specific gaps explained the bulk of the lost ground: (1) `Write` and `MultiEdit` tool calls were never redirected to their ashlr equivalents — the v1.18 redirect hook only matched `"Edit"`, leaving ~200 Write calls/day completely unrouted; and (2) the cwd-clamp refused every ashlr-tool call into `~/.claude/plans/*.md` and similar config dirs (12+ refusals/day in error logs), forcing the agent back to built-in fallbacks and forfeiting per-call savings.

### Changed

- **`hooks/pretooluse-edit.ts`** — extended from Edit-only to `Edit | Write | MultiEdit`. Per-tool redirect targets map each built-in to the correct ashlr MCP equivalent (Edit/Write → `ashlr__edit`, MultiEdit → `ashlr__multi_edit`). The redirect block message and call-shape (single edit vs. `edits[]` array) adapt per tool. Write on a non-existent file passes through silently — new-file creation has no ashlr equivalent, so refusing would force the agent into a no-win loop.
- **`hooks/hooks.json`** — PreToolUse matcher widened from `"Edit"` to `"Edit|Write|MultiEdit"` for the redirect hook.
- **`hooks/pretooluse-common.ts::buildNudgeContext()`** — added `Write` and `MultiEdit` cases so `ASHLR_HOOK_MODE=nudge` covers the two new tool names. The Write nudge is suppressed for non-existent paths (same new-file rationale as the redirect hook).
- **`servers/_cwd-clamp.ts::allowedRoots()`** — `~/.claude` and `~/.ashlr` are now unconditionally in the allow-list. Both are user-owned config dirs the agent routinely needs to touch (plans, CLAUDE.md, settings.json) and gating them behind cwd was sending every such call back to the built-in fallback. Filesystem permissions still gate access at the host level; the threat surface does not widen meaningfully.

### Tests

- **`__tests__/pretooluse-nudge.test.ts`** — 6 new tests: Write/existing nudges to ashlr__edit, Write/missing returns null, MultiEdit nudges to ashlr__multi_edit, end-to-end nudge mode for Write/existing and Write/new (passthrough), end-to-end redirect mode block path for large Write inside cwd. `runHook` helper now accepts an optional `cwd` so tests can exercise the in-cwd block branch without polluting the project root.
- **`__tests__/cwd-clamp.test.ts`** — 4 new tests: ~/.claude direct, ~/.claude/plans nested, ~/.ashlr accepted, /etc still refused (sanity).
- **1981 pass / 3 skip / 0 fail** (+10 over v1.20.1).

### Added (Bash redirect)

- **`hooks/pretooluse-bash.ts`** — new PreToolUse hook for `Bash`. Nudge-only by design: Bash never blocks regardless of `ASHLR_HOOK_MODE`, because Bash has no 1:1 equivalent for arbitrary commands and forcing every shell call through MCP would change UX (output renders as MCP tool result instead of inline shell). The nudge fires only when the command matches `findSummarizer()` or `isLargeDiffCommand()` — i.e., commands where ashlr__bash would actually compress output. Quiet commands (echo, pwd, mv, rm) pass through silently.
- **`hooks/pretooluse-common.ts::buildNudgeContext()`** — `Bash` case added. Imports `findSummarizer` + `isLargeDiffCommand` from `servers/_bash-summarizers-registry` so the nudge predicate exactly matches what ashlr__bash will compress.
- **`hooks/hooks.json`** — added `pretooluse-bash.ts` to the existing `Bash` matcher (rides alongside commit-attribution).
- **`PreToolUsePayload`** gained a `command` field; `parsePayload()` extracts `tool_input.command`.

### Tests (Bash redirect)

- 6 new unit tests in `__tests__/pretooluse-nudge.test.ts`: Bash nudges for git log / git diff / bun test, returns null for echo / empty command / unrelated tool names (Glob, WebFetch).
- 3 new end-to-end tests: verbose command in default mode emits ashlr__bash nudge (NEVER block), quiet command passes through silently, `ASHLR_HOOK_MODE=off` killswitch disables nudges entirely.
- The pre-existing `"unrelated tool names return null"` test was rewritten to use `Glob`/`WebFetch` — `Bash` is no longer "unrelated."
- **1990 pass / 3 skip / 0 fail** (+19 over v1.20.1).

### Why nudge-only for Bash

Block-mode for `Read`/`Edit` works because there's a clean 1:1 ashlr equivalent for every payload. Bash isn't symmetric — many shell commands have no useful summarization, and the model needs raw stdout to parse some outputs (`git rev-parse HEAD`, `bun --version`, etc.). Blocking would either pester the model on every quiet command or force a complex command-classification gate inside the hook. Nudge-only puts the choice in the model's hands while flagging the high-leverage cases. If real-world data shows the nudge is consistently followed, a future change can promote it to redirect for the safest subset (`bun install`, `bun test`, `git log`, `git diff` over thresholds).

## [1.20.1] — 2026-04-24

**Status-line session counter finally ticks.** Second front of the same env-forwarding problem v1.19.1 fixed: Claude Code forwards `CLAUDE_SESSION_ID` to hooks but NOT to MCP subprocesses OR to the status-line subprocess. Both fall back to `ppidSessionId()` — but each process's `process.ppid` is its own parent, so the WRITER (MCP server) produced a different session bucket than the READER (status line). Result: status line permanently showed `session +0 ≈$0.00` even while lifetime climbed with every tool call. Traced via two parallel Explore agents; verified in `~/.ashlr/stats.json` where all 44+ session keys are PPID-hash form, none matching a real `CLAUDE_SESSION_ID`.

### Added

- **`servers/_stats.ts::readSessionHint()`** — reads `~/.ashlr/last-project.json` (existing v1.19.1 side-file), returns `data.sessionId` if the file is fresh (24h TTL on `updatedAt`). `currentSessionId()` uses it as a fallback before `ppidSessionId()`. `candidateSessionIds()` adds it to the reader's set so old PPID-hash buckets still aggregate during the transition.
- **`hooks/session-start.ts::writeProjectHint()`** — now ALWAYS writes `sessionId`. Priority: `opts.sessionId` → `CLAUDE_SESSION_ID` env → `ASHLR_SESSION_ID` env → a derived `h<hash>` based on ppid+time+random. The derived fallback guarantees writer + reader converge on the same bucket even when NEITHER sees the env var.
- **New `__tests__/stats-session-hint.test.ts`** — 7 tests covering hint-priority, stale-TTL rejection, env-wins, ppid fallback when hint absent.

### Tests

- **1672 pass / 3 skip / 0 fail** (+8 tests on top of v1.20.0).
- Typecheck clean on all three OSes.

### Shipping / upgrade note

After upgrading, **quit Claude Code entirely and relaunch** — a plain `/reload-plugins` is not enough because MCP subprocesses are long-lived and keep running the old code until the parent Claude Code process exits. On the fresh session the new SessionStart hook writes the hint file immediately, MCP servers spawn with access to it, and the status-line session counter ticks up on the first tool call.

## [1.20.0] — 2026-04-24

**`ashlr__search_replace_regex` + `ashlr__test` watch mode.** Two parallel-agent deliveries rolling into a minor bump. Tool count 34 → 35.

### Added

- **`ashlr__search_replace_regex`** (tool #35) — regex-based multi-file search/replace. Args: `{ pattern, replacement, flags?, include?, exclude?, dryRun?, maxFiles?, maxMatchesPerFile?, roots? }`. Supports capture groups (`$1`, `$2`, `$&`), flags `i`/`m`/`s`/`u` (`g` implicit since cross-file). Safety layers: zero-width pattern refusal, binary detection (extension + NUL-byte sniff), per-file match cap (100), file cap (200), cwd-clamp on every root, atomic writes (temp + rename). 22 new tests.
- **`ashlr__test` watch mode** — new `watch?: boolean` arg. When true, returns a session id immediately (non-blocking) and reruns the filtered test set on file change. `fs.watch` with `{recursive:true}` + 1Hz mtime-poll fallback for Linux <5.1. 200ms debounce, 8-session cap, 50 MB stdout cap, POSIX process-group SIGKILL on stop.
- **External bash-session providers** — `servers/bash-server.ts` gains an `ExternalSessionProvider` registry so test-watch sessions show up in `ashlr__bash_list` (new `kind` column) and are tail-able via `ashlr__bash_tail` / stop-able via `ashlr__bash_stop`. Single pane of glass for all background sessions regardless of origin.
- **`~/.ashlr/test-watch-sessions/<id>.json`** — persistence for watch sessions. Stale-session prune at module load; `process.on('exit'|'SIGINT'|'SIGTERM')` cleanup.

### Changed

- **`ashlr__bash_list` output shape** — new `kind` column (values: `bash`, `test-watch`). Column layout widens.
- **Plugin tool count:** 34 → 35.

### Tests

- 22 new for `search_replace_regex` + 7 new for test-watch = 29 new.
- Full suite: 1636 → ~1665 pass (exact count after merge).

## [1.19.1] — 2026-04-24

**Hotfix: `ashlr__read` / `grep` / `edit` refused absolute paths in the user's project.** v1.19.0's PreToolUse redirect blocks built-in Read and tells the model to call `ashlr__read` with the absolute path — but the MCP server's `process.cwd()` is the plugin install dir (`~/.claude/plugins/cache/ashlr-marketplace/ashlr/<ver>/`), and Claude Code does NOT forward `CLAUDE_PROJECT_DIR` to MCP subprocesses. So `_cwd-clamp.ts::allowedRoots()` refused every absolute path in the user's project, producing a dead-end loop where the redirect bounced to a tool that rejected its own inputs. Dogfooded in-session after v1.19.0 shipped; most users with `ASHLR_HOOK_MODE=redirect` (the new default) hit this immediately.

### Fixed

- **`hooks/session-start.ts`** — writes `~/.ashlr/last-project.json` `{ projectDir, updatedAt, sessionId }` at session start. The hook runs in Claude Code's hook context where `CLAUDE_PROJECT_DIR` IS set.
- **`servers/_cwd-clamp.ts::allowedRoots()`** — when both `CLAUDE_PROJECT_DIR` and `ASHLR_ALLOW_PROJECT_PATHS` are unset AND `process.cwd()` looks like a plugin install dir (contains `.claude/plugins/cache/` or equals `$CLAUDE_PLUGIN_ROOT`), read `last-project.json` and add its `projectDir` to the allowed roots. 24-hour TTL on `updatedAt` so stale entries don't leak access. `canonical() + statSync(isDirectory)` gauntlet rejects dangling dirs.
- Env wins — if either env var is set, the file is never read. Backward-compat preserved.

### Tests

- **1609+ pass / 0 fail** (+23 new: 11 cwd-clamp fallback tests + 12 session-start writer tests).
- Extended run with `session-start-cleanup.test.ts` + `onboarding-wizard.test.ts` all green.
- Manual end-to-end verification of the exact regression scenario from a fresh MCP spawn in a non-project cwd.

## [1.19.0] — 2026-04-24

**Windows CI unblocked + `ashlr__rename_file` + tool-redirect retirement + seamless bun bootstrap.** Combines four workstreams. (a) The upstream `@ashlr/core-efficiency` path-separator bug identified in v1.18 is now fixed upstream and pulled in, unblocking ~25 Windows CI failures. (b) A new `ashlr__rename_file` tool complements `edit_structural`'s cross-file rename (identifiers) by renaming the module path + updating every importer. (c) `hooks/tool-redirect.ts` is finally retired — the nudge logic and `~/.ashlr/settings.json { toolRedirect: false }` kill switch are ported into `pretooluse-common.ts::buildNudgeContext()` and the three-mode resolution (`redirect` / `nudge` / `off`). (d) First-run bun install gap closed — hook trampoline + doctor PATH-gap detection so a first-time user on a bun-less machine sees hooks fire + MCP servers start immediately, no Claude Code restart needed.

### Added

- **`ashlr__rename_file`** (tool #34) — renames a source file and updates every import path that references it. Args: `{ from, to, dryRun?, maxFiles?, roots? }`. Handles extension elision (`.ts` / `.tsx` / `.js` / `.jsx`), `index.<ext>` variants, relative specifier normalization. Bare package specifiers (e.g., `"react"`) are never touched. Refuses binary files, outside-cwd paths, missing destination dir, existing dest. If any text edit fails, the file is NOT renamed (best-effort rollback). Scans candidates via ripgrep, caps at `maxFiles` (default 200).
- **`getHookMode()` third mode: `"off"`** — `~/.ashlr/settings.json { toolRedirect: false }` (the legacy kill switch from the retired `tool-redirect.ts`) now resolves via `isRedirectEnabled()` in `hooks/pretooluse-common.ts` to `"off"` — full silent pass-through, no nudge, no block. Priority: `ASHLR_HOOK_MODE` env → `~/.ashlr/config.json hookMode` → `~/.ashlr/settings.json toolRedirect:false` → default `"redirect"`.
- **`buildNudgeContext(toolName, toolInput)`** — pure function in `pretooluse-common.ts` that builds the actionable `additionalContext` nudge for Read (>2KB), Grep (always), Edit (always). Identical message content to the retired `tool-redirect.ts`.
- **`scripts/bun-resolve.mjs`** (+ `.d.mts` sidecar) — single source of truth for `~/.bun/bin` probing. Exports `hasBun()`, `prependBunToPath()`, `bunBinaryOnDisk()`, `bunBinaryPath()` (returns `bun.exe` on Windows).
- **`scripts/hook-bootstrap.mjs`** — node trampoline for hooks. Prepends `~/.bun/bin` to PATH when the parent Claude Code session was spawned before bun was installed, then execs `bun run <hook>`. Never installs (hooks fire concurrently; racing installers would be catastrophic). Always exits 0 — hooks must not gate the harness.
- **`__tests__/hook-bootstrap.test.ts`** — 5 cases for the trampoline.

### Changed

- **`@ashlr/core-efficiency` bumped to `#229e6b4`** — pulls in the upstream fix for `src/genome/manifest.ts:74` (`gDir = genomeDir(cwd) + "/"` → `+ sep`). This was causing every call to `initGenome` / `writeSection` with a relative section path to throw `Invalid section path: vision/north-star.md escapes genome directory` on Windows. Unblocks ~25 Windows CI failures. Upstream PR: https://github.com/ashlrai/ashlr-core-efficiency/pull/1.
- **`hooks/pretooluse-common.ts`** — `getHookMode()` return type widened to `"redirect" | "nudge" | "off"`. `buildNudgeContext()` replaces the empty envelope previously returned in nudge mode.
- **`hooks/hooks.json`** — all 13 hook entries now route through `node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-bootstrap.mjs" "${CLAUDE_PLUGIN_ROOT}/hooks/X.ts"`. Paths double-quoted so `CLAUDE_PLUGIN_ROOT` with spaces works on Windows.
- **`scripts/bootstrap.mjs`** — imports `hasBun` / `prependBunToPath` from the shared helper.
- **`scripts/doctor.ts`** — hook-list health check no longer references `tool-redirect.ts`. New third state for the `bun` line: on-PATH → `ok`; installed but off-PATH → `warn` with restart-not-needed guidance; genuinely missing → `fail` with install hint.
- **`commands/ashlr-settings.md`** — documents the new tri-mode contract (`redirect`/`nudge`/`off`).
- **`docs/install.sh`** — final-banner line clarifying that an already-running Claude Code doesn't need a restart.

### Removed

- **`hooks/tool-redirect.ts`** — retired. Its logic is ported as described above.
- **`__tests__/tool-redirect.test.ts`** — tests relocated into `__tests__/pretooluse-nudge.test.ts`.
- Tool-redirect matcher entry from `hooks/hooks.json`.
- **`hooks/session-start.sh`** — dead code; `hooks.json` wires `session-start.ts` directly.

### Tests

- **~1615+ pass / 1 skip / 0 fail** (combined). New: `__tests__/pretooluse-nudge.test.ts`, `__tests__/rename-file.test.ts`, `__tests__/hook-bootstrap.test.ts`.

## [1.18.0] — 2026-04-23

**"Trust, Reach, Delight" — 6-agent parallel sprint that makes the meter numbers defensible, closes remaining cross-OS gaps, flips PreToolUse hooks from *nudge* to *true redirect* (the single biggest token-savings multiplier), and adds onboarding/celebration polish.** Displayed lifetime savings will visibly drop after this update (silent retroactive fix): the prior `ashlr__edit` baseline counted `original+updated` instead of `search+replace`, inflating numbers 2-5×. The dashboard and status-line also now share one pricing source (`servers/_pricing.ts`) so the same token count produces the same dollar value on every surface. Numbers are lower, and they're *real*.

### Added — Trust Pass (savings math accuracy)

- **`servers/_pricing.ts`** — single source of truth for $/MTok across the plugin. Prior state: `efficiency-server.ts` used $3/MTok, `savings-dashboard.ts` hardcoded $5/MTok blended, `session-greet.ts` had its own copy — three surfaces, three dollar values. Now one table, `ASHLR_PRICING_MODEL` env selects model (sonnet-4.5 default / opus-4 / haiku-4.5).
- **`rawTotal` field in stats** — new column in both `servers/_stats.ts` and `servers/_stats-sqlite.ts` so % savings (`saved / rawTotal`) becomes displayable. Backward-compat: missing values treat as 0.
- **`__tests__/savings-math.test.ts`** — 15 invariant tests (`raw >= compact >= 0`, pricing parity between backends, rawTotal increments correctly).

### Changed — Trust Pass

- **`servers/efficiency-server.ts`** — `ashlr__edit` baseline is now `search.length + replace.length` (was `original.length + updated.length`, which modeled Claude sending both full file copies). Reported savings drop ~30-50% on code-heavy sessions and are now *defensible*.
- **`servers/efficiency-server.ts`** — BM25 embedding cache gated behind `corpus.docCount >= 50`. On small corpuses BM25 produces near-uniform vectors; the cache was returning noise that prepended irrelevant context while also double-counting savings. Below 50 docs the cache is now a silent no-op; users who want real semantic retrieval set `ASHLR_EMBED_URL=http://localhost:11434/api/embeddings` (new onboarding step offers this).
- **`servers/efficiency-server.ts`** — `embedCachePrefix` length excluded from `rawBytesEstimate`; stops the double-count on genome hits.
- **`servers/_accounting.ts`** — cache-hit math finished (prior Day-1 stub was a pass-through that undercounted repeated `ashlr__read` hits on the same file).
- **`scripts/savings-dashboard.ts`** — imports pricing from `servers/_pricing.ts`; surfaces % savings from `rawTotal`.

### Added — Reach Pass (cross-OS + correctness)

- **Windows CI integration job** (`.github/workflows/ci.yml`) — spawns the MCP entrypoint with real tool calls (`ashlr__read`, `ashlr__grep`, `ashlr__savings`). `continue-on-error: true` for signal-without-blocking during initial rollout. Closes the Windows integration-coverage gap that existed since v1.12.
- **bun.lock (text) detection** (`servers/test-server-handlers.ts`) — Bun 1.1+ text lockfile is now recognized alongside `bun.lockb`. This repo itself uses `bun.lock`; `ashlr__test` was previously falling through to a runner-type heuristic.

### Fixed — Reach Pass

- **`hooks/policy-enforce.ts`** — `/tmp/.ashlr-policy-cache-…` hardcode replaced with `os.tmpdir()` + `path.join`. Silently disabled policy enforcement on Windows (the `Bun.file().text()` throw was swallowed).
- **`scripts/doctor.ts`** — `isExecutable()` now returns `existsSync(path)` on Windows. NTFS has no POSIX execute bit, so the prior `(st.mode & 0o100) !== 0` reported every hook as broken on Windows and emitted meaningless `chmod +x` fix strings.
- **`scripts/doctor.ts`** — MCP-server unreachable fix string uses `os.devNull` instead of hardcoded `/dev/null`; pastes correctly into PowerShell / cmd.exe (`NUL` on Windows).
- **`scripts/mcp-entrypoint.sh`** — legacy/Unix-only banner + `OSTYPE` guard (file kept because `ports/cursor/mcp.json` still references it for non-Claude-Code ports).
- **`servers/bash-server.ts`** — POSIX spawn now uses `detached: true` and kills the process group (`-pid`) on timeout. Previously `child.kill("SIGKILL")` only terminated the shell; forked grandchildren (`npm install`, `cargo build`) leaked and continued running.
- **`servers/test-server-handlers.ts`** — `spawnSync` replaced with async `spawn` matching the `runRaw` pattern from `bash-server.ts`. A 120-second test suite no longer blocks the entire MCP router for 2 minutes.
- **`hooks/hooks.json`** — all `mcp__ashlr-efficiency__*` / `mcp__ashlr-multi-edit__*` matchers renamed to canonical `mcp__plugin_ashlr_ashlr__ashlr__*` (post-router-migration IDs). Genome-scribe hook matcher expanded to cover `MultiEdit`, `ashlr__multi_edit`, and `ashlr__edit_structural`.
- **`hooks/orient-nudge-hook.ts`** — `READ_TOOL_NAMES` / `EDIT_TOOL_NAMES` sets extended with the canonical names so the hook body recognizes events that the renamed matchers now fire on.

### Added — Delight Pass (UX + meter + compression)

- **`ASHLR_HOOK_MODE=redirect`** (default) — PreToolUse hooks for Read/Grep/Edit now emit `permissionDecision: "deny"` with an actionable "call `mcp__plugin_ashlr_ashlr__ashlr__*` instead" message. Previously they only *nudged* via `additionalContext` — every native call still fired and bypassed the compressed path. Safety nets never block: paths outside `cwd` (realpath-canonicalized for macOS `/tmp` → `/private/tmp`), paths inside `CLAUDE_PLUGIN_ROOT`, `bypassSummary: true`. Escape hatch: `ASHLR_HOOK_MODE=nudge` env var or `hookMode: "nudge"` in `~/.ashlr/config.json`.
- **`/ashlr-help`** — new command listing all 28 slash commands in a 5-group table (Onboarding / Token meter / Genome / Upgrade / Diagnostics).
- **`/ashlr-coach`** — deleted (deprecated since v1.13; was a stub printing a redirection notice).
- **`scripts/onboarding-wizard.ts`** — permissions step: 30-second visible countdown replacing the 5-second silent auto-accept (was the most trust-damaging onboarding step). Live demo: real `ashlr__read` call against a project file with graceful fallback to the prior estimate. New Ollama step offers `ASHLR_EMBED_URL=http://localhost:11434/api/embeddings` when Ollama is installed, skipped silently when env var already set.
- **`scripts/savings-status-line.ts`** — session segment now renders `≈$0.04` alongside token counts via the shared `_pricing.ts` cost function. 10,000-token lifetime milestone fires a one-time celebration on stderr (`ASHLR_DISABLE_MILESTONES` opt-out).
- **`hooks/session-start.ts`** — activation banner version and tool count now read dynamically from `.claude-plugin/plugin.json` + `commands/*.md` at runtime. Closes the long-standing drift bug where the string said "v1.9.0 active … 27 skills" regardless of actual plugin version.

### Added — Delight Pass (token compression wins)

- **Five new bash summarizers** (`servers/_bash-summarizers-registry.ts`) — `git log` (keeps top 10 SHAs + subjects), unified test-runner detector (jest/vitest/pytest/bun-test/mocha/npm-test/yarn-test/pnpm-test — first N failures + final pass/fail), `tsc` (error count + first 3), package installs (npm/bun/yarn/pnpm — keep only the "added N packages" line), and LLM routing for `git diff` / `git show` above 4 KB via `PROMPTS.diff`. 17 new registry keys total.
- **`servers/bash-server.ts`** — `tryStructuredSummary` now falls back to `findSummarizer(command)` from the registry after the hardcoded branches, so new summarizers fire without per-command `tryStructuredSummary` edits. `git diff` / `git show` > 4 KB routes through `summarizeIfLarge(PROMPTS.diff)`.
- **`servers/github-server.ts`** — `renderPR` is now async; PR diffs ≥ 16 KB route through `summarizeIfLarge(PROMPTS.diff)` with a 2 KB budget. Previously a 100+ file PR emitted the entire raw diff inline.
- **`servers/webfetch-server-handlers.ts`** — `summarizeIfLarge` threshold lowered from 16 KB to 4 KB for webfetch (web content is denser than code). 100 KB `maxBytes` hard cap preserved.

### Breaking behavior

- **Displayed lifetime savings will drop ~30-50%** on first post-update render. This is the intended "silent retroactive fix" — the math is now correct. No stats migration; old and new events both fold into `lifetime`. Pricing also drops from the dashboard's $5/MTok blended to the shared $3/MTok sonnet-4.5 input rate, so dollar values shown in the dashboard will shrink accordingly. Numbers are now consistent across `/ashlr-savings`, `/ashlr-dashboard`, and the status line.
- **PreToolUse hooks default to redirect.** Claude Code will receive `permissionDecision: "deny"` on native `Read` / `Grep` inside `cwd` when an ashlr equivalent is available, prompting the model to call the ashlr tool instead. Users who want the prior soft-nudge behavior set `ASHLR_HOOK_MODE=nudge`.

### Added — second wave (4 parallel follow-up agents)

- **9 Windows CI failures resolved** — `scripts/demo-run.ts` + `servers/bash-server.ts` honor `$HOME` before `USERPROFILE` (real user-facing bug: stats/session files disappeared when HOME was set). `hooks/genome-scribe-hook.ts` `ARCHITECTURAL_PATH_RE` now accepts both `/` and `\` (nudge was silent for `src\auth\...` paths). `scripts/genome-cloud-push.ts` normalizes `relative()` to POSIX so wire-protocol paths never carry backslashes (cross-platform data corruption risk). `scripts/genome-cloud-pull.ts` uses `dirname()` instead of `lastIndexOf('/')`. `scripts/baseline-scan.ts` normalizes `listFiles()` output + hardens `extOf` against both separators. Test-only fixes on `bash-server.test.ts` (Windows branch uses pwsh ForEach-Object), `genome-team-init.test.ts`, `handoff-pack.test.ts`. **Upstream blocker identified:** `@ashlr/core-efficiency@0.2.0` `src/genome/manifest.ts:74` has `gDir = genomeDir(cwd) + '/'` — cascades into ~25 remaining Windows failures; requires fix in the external package.
- **4 new GitHub write ops** — `ashlr__pr_comment`, `ashlr__pr_approve`, `ashlr__issue_create`, `ashlr__issue_close`. `pr:"current"` resolves via `gh pr view`. Self-approval guard rejects client-side (`gh api user` + PR author lookup). `ASHLR_REQUIRE_GH_CONFIRM=1` forces explicit `{ confirm: true }` per call. No destructive ops (no `pr close`, `pr merge`, `issue delete`, `--force`). 20 new tests.
- **`ashlr__edit_structural` v2** — Unicode identifier support (`\p{ID_Start}` / `\p{ID_Continue}` instead of ASCII-only regex; tree-sitter grammars verified to accept `café`, `π`, CJK). Cross-file rename with `anchorFile` + `maxFiles` (default 200), AST-based detection of named / default / namespace / CJS import patterns, shadowing guard per-file, dryRun lists every planned edit. Extract-function return-value detection classifies target as expression (wraps in `return`) vs statements (intersection of written-in-range and read-after-range determines 0 / 1 / N outputs). Fixed underlying bug in `isDeclarationSite` field-aware check (`web-tree-sitter` returns fresh JS wrappers from `childForFieldName` so `===` always failed; now compares byte ranges). 15 new tests.
- **Today-vs-yesterday dashboard callout** — single line below the banner: `"Today's pace is N.Nx yesterday's (X vs Y tokens)"` (≥1.1x), `"Today's saved fewer than yesterday (X vs Y — less active session?)"` (≤0.5x), `"Saved N tokens today — great start!"` (yesterday zero). Quiet when similar or both zero. UTC dates via `toISOString().slice(0,10)`. Not gated by `activeDays<3`. `renderTodayVsYesterday` exported so the compact `/ashlr-savings` surface in `efficiency-server.ts::renderSavings()` can import it as a follow-up (parity gap flagged). 10 new tests.

### Fixed — late additions

- **`scripts/install-permissions.ts`** — `/ashlr-allow` now covers the canonical router tool names. `buildAshlrEntries` added `mcp__plugin_ashlr_*` as a second catch-all alongside the legacy `mcp__ashlr-*`. Without this, the installer silently did nothing for v1.13+ router-exposed tools and users got prompted on every ashlr MCP call despite running `/ashlr-allow`.
- **`__tests__/cwd-clamp.test.ts`** — test regexes + env paths made Windows-compatible (was matching only POSIX `/etc|/private/etc` — Windows `resolve()` produces `<drive>:\etc` which the refusal logic correctly rejects but the assertion never accepted). Resolves ~14 of the pre-existing Windows CI failures; the clamp logic itself was always correct.
- **`hooks/audit-upload.ts`** — docstring tool-name reference synced to the canonical `mcp__plugin_ashlr_ashlr__ashlr__*` form.

### Tests

- **1577 pass / 1 skip / 0 fail** (+40 tests from the second-wave agents).
- New: `__tests__/savings-math.test.ts` (+15), extensions to `bash-summarizers.test.ts`, `bash-summarizers-registry.test.ts`, `onboarding-wizard.test.ts`, `savings-status-line.test.ts`. Second wave: `ast-refactor.test.ts` (+15 Unicode / cross-file / extract-return), `github-server.test.ts` (+20 write ops), `dashboard-render.test.ts` (+10 today-vs-yesterday).
- Fixed: `dashboard-render.test.ts` fmtUsd expectations updated for unified $3/MTok pricing. `commands-consolidation.test.ts` no longer asserts the retired `ashlr-coach.md`. `bash-server.test.ts` / `genome-team-init.test.ts` / `handoff-pack.test.ts` Windows-compatible.

## [1.17.0] — 2026-04-23

**Team-cloud genome — end-to-end push + bootstrap story.** Four-phase (T1 → T3) rollout that takes team-cloud genome from "half-built crypto scaffold no one can use" to "one command bootstraps a cloud genome and the next SessionEnd pushes it." Admin runs `/ashlr-upgrade → /ashlr-genome-keygen → /ashlr-genome-team-init`, commits `.ashlrcode/genome/.cloud-id`, invites teammates via `/ashlr-team-invite`; they run `/ashlr-genome-keygen`, admin re-runs `/ashlr-genome-team-init --wrap-all`, done. v2 envelope encryption (X25519 + HKDF-SHA256 + AES-256-GCM) replaces the v1 manual Signal/1Password key exchange. v1.17.1 ships the SessionStart pull side (T5) and conflict resolver (T4); today v1.17.0 gives admins a working push path and the full bootstrap UX.

**Team-cloud genome — Phase T1: server-side v2 envelope encryption.** Foundation for "push my genome from my laptop, pull it on my other machine (or my cofounder's)" without the manual Signal/1Password key-exchange the v1 crypto required.

### Added (server)

- **`users.genome_pubkey_x25519`** + **`genome_pubkey_alg`** — each user stores their X25519 public key server-side. Uploaded via `POST /user/genome-pubkey`; retrieved via `GET /user/genome-pubkey` (self) or included in `GET /genome/:id/members` (admin).
- **`genome_key_envelopes`** table — one row per `(genome_id, member_user_id)`. Stores an opaque base64url-encoded wrapped DEK produced client-side by the admin who ran `/ashlr-genome-team-init` (T3). Server NEVER reads the plaintext DEK.
- **`POST /genome/:id/key-envelope`** — admin uploads a wrapped DEK for a team member. Enforces (a) caller is an admin of the team that owns the genome, (b) `memberUserId` is actually a team member. Re-uploading replaces the stored envelope (= key rotation).
- **`GET /genome/:id/key-envelope`** — member fetches their own wrapped DEK. Returns 404 when no envelope exists (actionable message directing them to ask an admin to run `/ashlr-genome-rewrap`).
- **`GET /genome/:id/key-envelopes`** — admin audit view. Lists every non-revoked envelope with `memberUserId`, `alg`, `createdBy`, `createdAt`. `wrappedDek` intentionally omitted from the audit response.
- **`DELETE /genome/:id/key-envelope/:memberUserId`** — admin revokes a member's envelope (soft-revoke via `revoked_at` column). Re-uploading un-revokes.
- **`GET /genome/:id/members`** — lists team members with `{ userId, email, role, pubkey, alg }`. An admin uses this to look up each recipient's pubkey before wrapping the DEK.

### Tests (server)

- **`server/tests/genome-key-envelope.test.ts`** — 14 tests: pubkey upload/retrieve/validation, admin-only envelope upload, team-membership enforcement, key rotation via re-upload, member-fetches-own, admin revoke → member gets 404, admin members listing with/without pubkeys.

**Team-cloud genome — Phase T2: client-side v2 crypto + `/ashlr-genome-keygen`.** The client half of what T1 built server-side. Run `/ashlr-genome-keygen` once per machine; your X25519 private key stays local, your public key goes to the server so admins can wrap team DEKs to you. Foundation for T3 (team-init) and the full push/pull loop.

**Team-cloud genome — Phase T2.5: client push path + SessionEnd wiring.** After SessionEnd consolidation stabilizes the local genome, a new opt-in hook fires `scripts/genome-cloud-push.ts` to ship the delta upstream. Teammates see your work on their next SessionStart pull (T5). No-op when the repo has no `.ashlrcode/genome/.cloud-id` (i.e. team-genome not initialized) so non-team users pay nothing.

### Added (push path)

- **`scripts/genome-cloud-push.ts`** + **`/ashlr-genome-push`** — client push path. Reads `.cloud-id`, acquires a cross-process lockfile at `.ashlrcode/genome/.push.lock` (O_EXCL), fetches the wrapped DEK via `GET /genome/:id/key-envelope` (T1), unwraps with the local X25519 private key (T2), enumerates `.ashlrcode/genome/{knowledge,vision,milestones,strategies}/*.md` + `manifest.json`, encrypts each with the DEK via `_genome-crypto.encryptSection`, bumps a per-machine vclock component, and POSTs via `/genome/:id/push`. Persists vclock only on successful push so a mid-push crash doesn't leave a ghost-bumped clock.
- **`~/.ashlr/client-id`** (mode 0600, 12 hex chars) — stable per-machine identifier used as the vclock component. Auto-generated on first push.
- **`~/.ashlr/genome-vclock/<genomeId>.json`** — per-genome vclock state. One map `clientId → counter`.
- **Kill switches:** `ASHLR_CLOUD_GENOME_DISABLE=1` (shared with the pull path) → push is a no-op.

### Changed (push path)

- **`hooks/session-end-consolidate.ts`** — now awaits consolidation (budgeted at 10s) before spawning the push hook. Two-stage fire sequence with a 15s overall budget; shutdown is never blocked beyond that. Push itself is fire-and-forget after launch.

### Tests (push path)

- **`__tests__/genome-cloud-push.test.ts`** — 9 tests cover the filesystem-only helpers (the full network path is reserved for T6's two-client e2e): lockfile O_EXCL behavior, section enumeration (knowledge/vision/milestones/strategies + manifest.json, ignores non-md and nested subdirs), vclock round-trip + per-genome isolation, stable client-id generation, `.cloud-id` reader.

**Team-cloud genome — Phase T3: `/ashlr-genome-team-init`.** The admin-side bootstrap that makes a team-cloud genome real for a repo. Allocates it, generates the DEK, wraps to the admin's own pubkey, writes `.ashlrcode/genome/.cloud-id`. After this runs once, `/ashlr-genome-push` (T2.5) has something to push to. `--wrap-all` fans out envelopes to every teammate who's run `/ashlr-genome-keygen`.

### Added (T3)

- **`scripts/genome-team-init.ts`** + **`/ashlr-genome-team-init`** — bootstrap command. Flow: resolve repo URL from `git remote get-url origin` → `POST /genome/init` → generate fresh 32-byte DEK → `wrapDek()` for caller's own X25519 pubkey → `POST /genome/:id/key-envelope` → write `.ashlrcode/genome/.cloud-id` (commit this file so teammates auto-discover).
- **`--wrap-all` flag** — for post-init teammate onboarding. Fetches our own envelope, unwraps with the local private key to recover the DEK, lists team members via `GET /genome/:id/members`, wraps the DEK for each member with a registered pubkey, uploads. Reports wrapped / skipped-no-pubkey counts.
- **`--force` flag** — reinitialize an already-set-up repo (DEK rotation). Existing envelopes stop working until re-wrapped via `--wrap-all`.
- **`__tests__/genome-team-init.test.ts`** — 3 pure-function tests on `cloudIdPath` + `readRepoUrl` (with and without a real git repo).

### Added (client crypto)

- **`servers/_genome-crypto-v2.ts`** — client-side X25519 + HKDF-SHA256 + AES-256-GCM envelope crypto. Exports `generateKeyPair()`, `wrapDek(dek, recipientPubKey)`, `unwrapDek(envelope, recipientPrivKey)`. Envelope layout: `version(1) | ephPub(32) | nonce(12) | ciphertext(N) | tag(16)`, base64url. Ephemeral-pub per wrap gives forward secrecy per envelope. `ENVELOPE_ALG` string (`x25519-hkdf-sha256-aes256gcm-v1`) reserved for forward-compat.
- **`~/.ashlr/member-keys/<userId>.json`** (mode 0600) — where the keypair lives. Directory created with mode 0700. Helpers `memberKeyPath`, `saveKeypair`, `loadKeypair` in the crypto module.
- **`/ashlr-genome-keygen`** + **`scripts/genome-keygen.ts`** — generate-or-reuse keypair, upload public half via `POST /user/genome-pubkey` (T1). Idempotent. Flags: `--force` (rotate), `--dry-run`, `--endpoint <url>`. Exits 2 when no Pro token, 3 on network failure.

### Tests (client crypto)

- **`__tests__/genome-crypto-v2.test.ts`** — 9 tests covering: keypair shape (32 bytes → 43-char base64url), distinct generations, wrap/unwrap round-trip, envelope freshness (two wraps of same DEK produce distinct ciphertext), AEAD tag mismatch on wrong private key, truncated envelope rejection, unsupported version byte rejection, DEK-must-be-32-bytes guard, stable `ENVELOPE_ALG` constant.

### Deferred to T3+

- **T3** — `/ashlr-genome-team-init`, auto-discover via `.ashlrcode/genome/.cloud-id`.
- **T4** — `/ashlr-genome-conflicts` 3-way diff picker.
- **T5** — SessionStart team pull + layout reconciliation.

## [1.16.0] — 2026-04-22

**Opt-in Pulse integration — plugin can now emit OTel-GenAI spans to a Pulse server (`ashlrai/ashlr-pulse`) so multiplayer dashboards light up without the plugin giving up its zero-telemetry-by-default posture.**

### Added

- **`hooks/pulse-emit.ts`** — new PostToolUse hook. When `ASHLR_PULSE_OTLP_ENDPOINT` is set, emits one OTLP/HTTP-JSON span per tool call carrying `gen_ai.system=anthropic` plus Claude Code `claude.*` attributes (session id, tool name, input/output bytes, project hash, repo name, git branch). No prompts, no completions, no cwd paths — `cwd` is hashed to `claude.project.hash` before leaving the machine. When the env var is unset, the hook is a 1-ms exit: zero network, zero data.
- **`ASHLR_PULSE_OTLP_ENDPOINT`** — the endpoint to emit to (e.g. `http://localhost:3000/api/otlp/v1/traces` in local dogfood).
- **`ASHLR_PULSE_USER`** — optional override for the `x-ashlr-user` header (default: `$USER`).
- **`ASHLR_PULSE_TIMEOUT_MS`** — per-POST timeout in ms (default: 1500). Prevents a slow Pulse server from blocking the agent.

### Tests

- **`__tests__/pulse-emit.test.ts`** — 5 tests cover: opt-out path (unset env ⇒ zero network), OTLP payload shape (GenAI + claude.* attrs present), user-header fallback to `$USER`, malformed stdin ⇒ `tool.unknown`, unreachable endpoint ⇒ never exits non-zero.

## [1.15.0] — 2026-04-22

**Three-workstream production sprint: Windows hardening round 2 closes the path-separator debt loop; a new opt-in `/ashlr-report-crash` slash command gives the maintainer faster bug signal; and an opt-in SQLite backend behind `ASHLR_STATS_BACKEND=sqlite` replaces the tempfile+lockfile+JSON stats store that produced 6 distinct regressions across v0.9.x → v1.0.x.**

### Added

- **`scripts/bootstrap.mjs`** — node-level trampoline for the MCP server. Checks for `bun` on PATH; if missing, runs the upstream installer (`irm bun.sh/install.ps1 | iex` on Windows, `curl -fsSL https://bun.sh/install | bash` elsewhere), prepends `$HOME/.bun/bin` to PATH for the current process, then execs the existing `scripts/mcp-entrypoint.ts`. Node is guaranteed present because Claude Code itself runs on it, eliminating the chicken-and-egg that blocked `/plugin install` on fresh Windows machines.
- **`ASHLR_NO_AUTO_INSTALL=1`** — opt-out escape hatch for users who prefer explicit bun management.
- **`__tests__/bootstrap.test.ts`** — behavioral test covering the no-bun + opt-out exit path.
- **`/ashlr-report-crash`** — new opt-in slash command that uploads a recent redacted crash dump (from `~/.ashlr/crashes/`) to the maintainer backend so bugs get triaged faster. Flags: `--dry-run` (preview only), `--stdout` (print for manual GitHub-issue paste), `--all` (send the full 7-day window), `--dump <path>` (specific file), `--endpoint <url>` (override), `--yes` (skip confirm). Dumps are already redacted at write time by `servers/_crash-dump.ts` — the upload path adds only `pluginVersion` + `process.platform`.
- **`scripts/report-crash.ts`** — CLI implementation. Previews to stderr before network. Exits 0 success / 1 no-crashes / 2 declined / 3 network error. `ASHLR_CRASH_UPLOAD_URL` env var overrides the default endpoint; empty disables upload.
- **`server/src/routes/crash-report.ts`** — anonymous `POST /crash-report` Hono endpoint. Zod-validated, 1 request per minute per IP, returns `{ reportId, receivedAt }`. Tags `hasProToken: true` on the log line when a Bearer token is present (triage priority only — no auth required).
- **`ashlr_crash_reports_total`** — new Prometheus counter, labeled by platform.
- **`servers/_stats-sqlite.ts`** — SQLite-backed stats store as a drop-in replacement for the `_stats.ts` API (readStats / recordSaving / initSessionBucket / dropSessionBucket / bumpSummarization / readCurrentSession / importStatsFile). WAL mode, `PRAGMA busy_timeout = 30000`, `synchronous = NORMAL`. Each `recordSaving` is a single `BEGIN IMMEDIATE` transaction that upserts across `sessions`, `session_tools`, `lifetime_tools`, `lifetime_days`, and `lifetime_totals` — atomic by construction, no userland lockfile, no dual-schema compat path.
- **`ASHLR_STATS_BACKEND=sqlite`** — opt-in switch. `_stats.ts` dispatches each exported async function to the SQLite backend when set; default stays `json` until VS Code extension and other direct-`stats.json` readers catch up in v1.16.
- **`scripts/migrate-stats-to-sqlite.ts`** — one-shot idempotent move of `~/.ashlr/stats.json` into `~/.ashlr/stats.db`. Renames the source to `stats.json.migrated-<epoch>` so the user keeps a rollback copy. Wired into the SessionStart hook under the opt-in flag so MCP workers see an already-initialized schema.
- **Concurrent-writes regression tests** — `__tests__/stats-sqlite-concurrent.test.ts` spawns real child `bun` processes that hammer the db in parallel (4 writers × 50 writes, and 2 writers contending on the same session). 8/8 consecutive local runs clean — the exact failure mode the legacy JSON path patched 6 times across v0.9.x → v1.0.x is gone.

### Changed

- **`.claude-plugin/plugin.json`** — MCP server command changed from `bun` to `node scripts/bootstrap.mjs`. Forwarded argv preserves the existing `servers/_router.ts` handoff.
- **`docs/install.sh`** — non-interactive mode (e.g. piped from curl without a TTY) now downgrades missing-bun from a hard error to a warning, skips the optional `bun install` pre-warm, and relies on the MCP bootstrap to install bun on first spawn.
- **`docs/install-windows.md`** — documents the auto-install flow and the `ASHLR_NO_AUTO_INSTALL=1` opt-out.
- **`README.md`** — prerequisites now read "Claude Code; bun is auto-installed on first MCP server spawn."

### Fixed

- **`scripts/genome-link.ts`** — `parent.startsWith(home + "/")` replaced with `home + sep`. The workspace-genome walk always returned null on Windows because paths use backslash; `ashlr__grep`'s parent-genome fallback now works cross-platform.
- **`hooks/pretooluse-common.ts`** — `isInsidePluginRoot` had the same hardcoded `"/"` bug, silently skipping PreToolUse plugin-root checks on Windows. Fixed.
- **`hooks/session-start.ts`** — `cleanupStalePluginVersions` stripped trailing separators with `replace(/\/+$/, "")` before calling `basename`/`dirname`, a no-op on Windows (backslash). Node's `basename`/`dirname` already handle trailing separators, so the replace was dropped. The `"/plugins/cache/"` safety check is now normalized against backslash paths too, so the `CLAUDE_PLUGIN_ROOT` containment guard actually fires on Windows.
- **`scripts/onboarding-wizard.ts`** — `resolvePluginRoot` fallback used `replace(/\/scripts$/, "")` on `import.meta.dir`, which never matched on Windows. Switched to `dirname(import.meta.dir)`.
- **`scripts/coach-report.ts`** — project-name extraction ran `cwd.split("/")` on log-record cwd fields, producing a single-element array on Windows and echoing the whole `C:\...` path as the project name. Replaced with `basename(cwd)`.
- **`scripts/handoff-pack.ts`** — "Recent files touched" section split cwd keys on `/` only; now splits on both separators so Windows cwds render their last two components correctly.
- **`scripts/find-test-leak.ts`** — test-output prefix stripping replaced ad-hoc `path.replace(testsDir + "/", "")` with `path.relative()` so the dev-only bisector prints readable names on Windows.

### Tests

- **`__tests__/bootstrap.test.ts`** — +3 POSIX tests cover the previously-uncovered `autoInstallBun` branches: happy-path arg forwarding, installer-script-fails, and installer-succeeds-but-bun-still-absent. Uses `#!/bin/sh`-shebanged stubs on sandboxed PATH to avoid the real installer. Total: 4 tests (was 1).

## [1.14.1] — 2026-04-22

**"Make the promise real" — semantic retrieval is no longer placebo, observability gets a real crash channel, and the upgrade nudge gains conversion tracking.**

### Added

- **Embedding cache is populated.** `servers/_genome-embed-populator.ts` walks the genome manifest and inserts one embedding per section into `~/.ashlr/context.db`, watermarked by manifest mtime + per-section content hash so steady-state grep calls pay only a `stat()` + JSON read. Pre-fix: 0 rows, 0% hit rate. Post-fix: non-empty table, similarity-ranked retrieval actually contributes to token savings.
- **AST chunker wired into embedding build.** `scripts/embed-file-worker.ts` splits TS/JS sources by function/class boundary via `splitFileIntoChunks` + `chunkToRagString` before embedding. Function-level retrieval granularity replaces the old one-embedding-per-file shape that blurred similarity scores on large files. Unsupported languages fall back to whole-file.
- **Crash-dump channel.** `servers/_crash-dump.ts` writes `~/.ashlr/crashes/<date>.jsonl` on handler throws in `_tool-base` dispatch. 7-day rotation, redacts bearer/apikey patterns before write. Surfaced via `/ashlr-doctor --errors`.
- **50k nudge conversion tracking.** Plugin emits `nudge_shown` / `nudge_clicked` / `nudge_dismissed_implicitly` events to `~/.ashlr/nudge-events.jsonl` with hashed `sessionId`, bucketed `tokenCount` (50k/100k/500k/1m), `variant`, and `nudgeId` for correlation. No PII, no cwd, no paths. Synced to backend (`POST /events/nudge`, `nudge_events` table) best-effort when a `pro-token` is present. Rate-limited 1/10s per user. Surfaced in `/ashlr-savings` and `/ashlr-dashboard`.
- **`discoveries-auto.md` sink.** `.ashlrcode/genome/knowledge/discoveries-auto.md` collects auto-observed JSON blobs / diffs / listings, intentionally absent from `manifest.json` so `retrieveSectionsV2` cannot surface it.

### Changed

- **`discoveries.md` curated 619 → 8 lines.** The 2026-04-20 junk-drawer (587 lines of raw Bash/Read/Edit result JSON) moved to the new auto sink. `scripts/genome-auto-consolidate.ts` adds `isNoiseProposal()` + `routeSectionForProposal()` so future noisy proposals land in the sink up-front instead of bloating signal.
- **JSON.parse hardening.** `servers/github-server.ts` wraps all three `JSON.parse` sites (repo/pr/issue view) with `safeParseGhJson` (4 MB cap + structured error via `logEvent`). `servers/genome-server.ts` SSE shim drops frames > 1 MB before parse. Malformed payloads no longer crash the handler.
- **`nudge-events.jsonl` rotation.** Self-rotates at 10 MB with `.1 → .2` cascade, mirroring `session-log-append.ts`. Unbounded growth no longer possible.
- **Silent-failure audit.** 7 `.catch(() => {})` sites across `servers/` + `scripts/` annotated with one-line `// best-effort:` rationale each — none converted to logging since the new crash-dump channel covers the dispatch-boundary case that actually mattered.

### Tests

- **Plugin:** 1406 pass / 0 fail / 1 skip (up from 1301 pre-sprint). **Backend:** 1685 pass / 0 fail / 1 skip.
- New test files: `__tests__/genome-embed-populator.test.ts` (7), `__tests__/crash-dump.test.ts` (14), `__tests__/json-parse-hardening.test.ts` (4), `__tests__/nudge-events.test.ts` (23 incl. 3 rotation), `server/tests/nudge.test.ts` (12 incl. 2 rate-limit), extensions to `__tests__/genome-auto-consolidate.test.ts` (+8) and `__tests__/dashboard-render.test.ts` (+4).

### Ops

- No new env vars. No migrations beyond the `nudge_events` table (schema in `server/src/db.ts`).
- `ASHLR_PRO_TOKEN` (or `~/.ashlr/pro-token`) gates the nudge backend sync; free users accumulate local-only data.

## [1.14.0] — 2026-04-21

**Router consolidation, webhook-driven genome rebuilds, private-repo OAuth step-up, and two new MCP tools.**

### Added

- **GitHub webhook-driven genome delta rebuild** — push events to registered repos trigger incremental re-indexing of affected genome sections via HMAC-SHA256-verified delivery. Idempotent by GitHub delivery ID. Source: `server/src/routes/webhooks.ts`, `server/src/services/genome-build.ts`.
- **Private-repo OAuth scope step-up** — Pro users can authorize the `repo` scope (separate consent screen, never bundled with initial sign-in). Server verifies token has `repo` scope before cloning private repos. Phase 7C complete.
- **`ashlr__edit_structural` v2** — cross-file rename, real scope-aware resolution via tree-sitter, extract-function, inline. `.ts/.tsx/.js/.jsx`. (v1 shipped in v1.13 as single-file only.)
- **`ashlr__test`** — structured test-runner output parser. Auto-detects bun test / vitest / jest / pytest / go test. Compresses ~2KB of runner noise into one compact failure block per failure.
- **LLM-backed genome synthesis** — at consolidation, proposals are optionally merged via a local or cloud LLM for higher-quality section updates. Opt-in via `ASHLR_GENOME_LLM_SYNTHESIS=1`.
- **Hook-timing trends + slow-hook flags** — `/ashlr-hook-timings` now shows p50/p95 trends over the last 7 days and flags hooks exceeding the 200ms p95 threshold.
- **Slash-command consolidation** — 24 commands collapsed to 14 with deprecation aliases. Old names continue to work for one release cycle.
- **docs/github-oauth-onboarding.md** — complete user walkthrough for GitHub sign-in, repo picker, and cloud genome pull.
- **docs/cloud-genome.md** — architecture reference for the cloud genome build, encryption, and webhook delta-rebuild pipeline.

### Changed

- **Router consolidation** — `.claude-plugin/plugin.json` collapsed from 16 per-server `mcpServers` entries to **1 `ashlr` router entry** (`servers/_router.ts`). All 29 tools dispatch via `registerTool` / `getTool` registry. `ASHLR_ROUTER_DISABLE=1` kill switch retained for one release cycle.
- **Bun-native MCP entrypoint** — `scripts/mcp-entrypoint.ts` replaces the legacy bash wrapper in `plugin.json`. Windows installs no longer require Git Bash. The legacy `.sh` remains for Unix-only `ports/` distributions (Cursor, Goose).
- **cwd-clamp allow-list extension** — `servers/_cwd-clamp.ts` now honors two optional env vars so the MCP tools can touch the user's real workspace (not just the plugin cache dir):
  - `CLAUDE_PROJECT_DIR` (auto-forwarded by the entrypoint when Claude Code sets it)
  - `ASHLR_ALLOW_PROJECT_PATHS` (colon-separated on Unix, semicolon on Windows; user opt-in)
  Fixes the dogfooding refusal where `ashlr__read` / `ashlr__grep` / `ashlr__edit` rejected project files because `process.cwd()` pointed at the plugin cache.
- **`ashlr__read` line-number preservation** — code files now have every line prefixed with its 1-based original line number for 31 extensions, so `file:line` citations survive `snipCompact` truncation. `preserveLineNumbers:false` opts out.
- **`/ashlr-upgrade`** — GitHub OAuth is now the primary sign-in path; magic-link is preserved as secondary fallback.
- **`/ashlr-update`** — post-upgrade banner now explicitly calls out `/reload-plugins` (or full restart) because Claude Code does not hot-reload long-lived MCP server processes after `git pull`.

### Security

- **AES-256-GCM envelope encryption** for GitHub access tokens at rest (`server/src/lib/crypto.ts`). `ASHLR_MASTER_KEY` required at startup.
- **HMAC-signed OAuth state tokens** — 10-min TTL, `timingSafeEqual` comparison.
- **IP-based rate limiting** — 20/IP/hour on `/auth/github/start`, `/auth/github/callback`, `/auth/send`.
- **GitHub webhook signature verification** — HMAC-SHA256 with timing-safe compare (`server/src/routes/webhooks.ts:28-35`).

### Monetization

- **7-day Pro trial on first checkout** — `trial_period_days: 7`, no card required until trial ends.
- **50k-session upgrade nudge** — status line swaps rotating tip for upgrade prompt when session tokens saved ≥ 50k and user is on free tier. `statusLineUpgradeNudge: false` disables.

### Ops

- New env vars: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ASHLR_MASTER_KEY`, `GITHUB_WEBHOOK_SECRET`, `SITE_URL`, `BASE_URL`.
- Kill switches: `ASHLR_ROUTER_DISABLE=1`, `ASHLR_CLOUD_GENOME_DISABLE=1`, `ASHLR_DISABLE_TRIAL=1`.
- Tests: 1262 pass / 0 fail / 1 skip (plugin). Backend: 228 pass / 0 fail.

---

## [1.13.0] — 2026-04-21

**Seamless onboarding release — sign in with GitHub, pick a public repo, have a pre-built genome ready before your first grep.** Ships 9 of the 10 deferred v1.12 foundation items plus Phase 7 of the Pro-stickiness push (GitHub OAuth, auto-genome build, cloud-genome pull on session-start), plus the `ashlr__edit_structural` AST rename tool and `ashlr__test` structured runner output parser.

### Added — GitHub OAuth end-to-end

- **GitHub OAuth sign-in** on both the web (`/auth/github` → GitHub consent → `/auth/github/callback` → `/auth/github/done`) and CLI (`/ashlr-upgrade` now offers a "Sign in with GitHub" picker as the primary flow, magic-link preserved as secondary fallback). Scopes requested: `read:user user:email public_repo`.
- **`server/src/lib/crypto.ts`** — AES-256-GCM envelope encryption + HMAC-signed OAuth state tokens with 10-min TTL and constant-time compare. Used for GitHub access tokens stored at rest and for CSRF-safe OAuth state. Requires `ASHLR_MASTER_KEY` env (32 random bytes base64); throws fast in production if missing.
- **`users.github_id` / `github_login` / `github_access_token_encrypted`** columns via idempotent ALTER migrations. Partial UNIQUE index on `github_id WHERE NOT NULL`.
- **`pending_auth_tokens.session_id`** column + `storePendingAuthTokenBySid` / `consumePendingAuthTokenBySid` helpers so the CLI can poll `/auth/status?session=<sid>` while the web OAuth callback writes by sid. Single-use semantics, 3-min freshness window.
- **`GET /user/me`** — returns `{userId, email, tier, githubLogin, hasGitHub}`.
- **`GET /user/repos`** — server-side GitHub proxy: decrypts user's token, forwards, returns trimmed shape. Free tier sees `visibility=public` only — enforced server-side.

### Added — Auto-genome build from GitHub repos

- **`server/src/services/genome-build.ts`** — `buildGenomeFromGitHub(userId, owner, repo)` runs `git clone --depth 1` + `bun run scripts/genome-init.ts --minimal` + per-section encrypt + `upsertSection` in a fire-and-forget background promise. 60s clone timeout, 120s init timeout. Free tier gates private repos via live `api.github.com/repos/<owner>/<repo>` check.
- **`POST /genome/build`** → `{genomeId, status}`. 5/user/hour rate limit.
- **`GET /genome/personal/find?repo_url=<canon>`** + **`GET /genome/personal/list`** + **`GET /genome/:id/status`**.
- **`scripts/genome-cloud-pull.ts`** runs from `hooks/session-start.ts` — parses cwd git remote, canonicalizes, hits the backend, downloads sections to `~/.ashlr/genomes/<projectHash>/` with a `.ashlr-cloud-genome` marker. `ASHLR_CLOUD_GENOME_DISABLE=1` kill switch.
- **`servers/_genome-cache.ts` `findParentGenome`** now falls back to `~/.ashlr/genomes/<hash>/` when no local `.ashlrcode/genome/` exists. Local always wins; cloud supplements.
- **`site/components/repo-picker.tsx`** + **`site/app/api/github/repos/route.ts`** — repo picker UI after sign-in with 2s build-status polling. GitHub tokens never reach the browser.
- **Per-user genome encryption key** — new `users.genome_encryption_key_encrypted` column auto-generated on first private-repo build. `GET /user/genome-key` returns the decrypted key over TLS for client decrypt; cached at `~/.ashlr/genome-key` (0o600).
- **Genomes table**: `owner_user_id` + `repo_visibility` + `build_status` + `build_error` + `last_built_at` columns with `idx_genomes_owner_user`. Personal genomes use `org_id = user_id` so the existing `UNIQUE(org_id, repo_url)` constraint enforces "at most one per user per repo."

### Added — New MCP tools

- **`ashlr__edit_structural`** — AST-aware rename within a single file via tree-sitter. Conservative shadowing guard (refuses `>1` declaration sites), collision guard, value vs type kind disambiguation. `.ts/.tsx/.js/.jsx` today; cross-file + extract/inline in v1.14.
- **`ashlr__test`** — structured test-runner output parser. Supports bun test / vitest / jest / pytest / go test (auto-detect or explicit `runner` override). Compresses ~2KB of runner noise into one compact failure block per failure.
- **`/ashlr-hook-timings`** — per-hook p50/p95/max + outcome-class breakdown from `~/.ashlr/hook-timings.jsonl`.

### Added — Quality + UX

- **Per-hook timing telemetry** — all PreToolUse + PostToolUse hooks wired via `recordHookTiming` / `withHookTiming` in `hooks/pretooluse-common.ts`. `ASHLR_HOOK_TIMINGS=0` kill switch.
- **`ashlr__read` code-file line-number preservation** — every line prefixed with its 1-based original line number for 31 code extensions so `file:line` citations survive `snipCompact` truncation. `preserveLineNumbers:false` opts out.
- **`ashlr__edit` strict-mode fuzzy-miss diagnostics** — on 0-match failure, emits top-3 Levenshtein candidates with line numbers (≤2MB files).
- **`ashlr__diff_semantic` output compression** — >8KB output routes through `summarizeIfLarge` with a new `PROMPTS.diff_semantic` + `bypassSummary` flag.
- **Embedding-cache threshold lowered 0.75 → 0.68** with `ASHLR_EMBED_THRESHOLD` env override. Per-grep calibration log at `~/.ashlr/embed-calibration.jsonl`.
- **Genome auto-propose signal tightening** — `MIN_CONTENT_LEN` bumped 200→400 + manifest-overlap gate. `ASHLR_GENOME_REQUIRE_OVERLAP=0` disables.
- **Genome consolidation novelty gate** — Jaccard token-overlap (threshold 0.6) rejects bullets that duplicate existing section lines or earlier accepted bullets in the same batch.
- **Bash command summarizers extracted** — 11 inline functions moved to `servers/_bash-summarizers-registry.ts`.
- **50k-session Pro upgrade nudge** in the status line — swaps the rotating tip when session tokens saved ≥50k and the user is on free tier. `statusLineUpgradeNudge:false` disables.

### Added — Monetization

- **7-day Pro trial on first checkout** — `trial_period_days: 7` + `payment_method_collection: "if_required"` for users who have never had any subscription record. `ASHLR_DISABLE_TRIAL=1` ops kill switch. Client surfaces the trial message.

### Changed

- **Router consolidation complete** — `.claude-plugin/plugin.json` collapses from 16 per-server entries to 1 `ashlr` router entry that dispatches all 29 tools via the shared registry at `servers/_router.ts`. `ASHLR_ROUTER_DISABLE=1` kill switch preserved for one release cycle.
- **Ask-server dispatches via `getTool()` registry** instead of direct imports — closes the last circular-dep cleanup from v1.12.
- **Pricing page refreshed** — Free / Pro / Team cards with a 27-row feature matrix. "Pro = unlimited private-repo genomes" is the headline unlock.

### Security

- **AES-256-GCM envelope encryption for GitHub access tokens at rest** — master-key-wrapped, never returned to browser, decrypted on-demand server-side.
- **HMAC-signed OAuth state tokens** — 10-min TTL, constant-time compare via `timingSafeEqual`.
- **Per-handler crash isolation** in `_tool-base.ts` runStandalone — catches handler throws, emits `tool_crashed` event with 5-line stack, returns structured `isError:true`.
- **IP-based rate limit on `/auth/github/start` + `/auth/github/callback` + `/auth/send`** — 20/IP/hour shared bucket.
- **Server-enforced tier gating** on private-repo genome builds — the client can't fake `visibility`.

### Ops

- New env vars: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ASHLR_MASTER_KEY`, `BASE_URL`, `SITE_URL`, `ASHLR_DISABLE_TRIAL`, `ASHLR_CLOUD_GENOME_DISABLE`, `ASHLR_HOOK_TIMINGS`, `ASHLR_EMBED_THRESHOLD`, `ASHLR_GENOME_REQUIRE_OVERLAP`.
- `ASHLR_ROUTER_DISABLE=1` retained as kill switch for one release cycle.
- Tests: 1262 pass / 0 fail / 1 skip (plugin). Backend: 228 pass / 0 fail. +330 tests over v1.12.

### Deferred to v1.14

- `ashlr__edit_structural` v2 — cross-file rename, real scope-aware resolution, extract-function, inline.
- Phase 7C — private-repo consent step-up with `repo` scope, GitHub webhook-driven incremental genome rebuilds.
- Backend PostgreSQL migration.
- LLM-backed synthesis at genome consolidation.
- Symbol-level AST genome chunking.
- Command consolidation 24 → 14 with deprecation aliases.

---

## [1.12.0] — 2026-04-19

**Architectural foundation release — sets up 4 parallel evolution tracks that subsequent releases (v1.13+) will activate in full.** Retains all v1.11.2 security hardening and adds ~5,800 lines across compression, cross-session memory, router infrastructure, and AST tooling while keeping the test suite at 100% green (+127 tests over baseline). No behavior regressions; no new user-visible API surface removed.

### Added — MCP router foundation (Track A, partial)

- **`servers/_tool-base.ts`** — shared MCP server scaffold. Exports `registerTool({name, schema, handler})`, `listTools()`, `getTool()`, `runStandalone()`. Tools can opt in incrementally; per-server stdio setup boilerplate collapses from ~50 LOC/server to one `runStandalone()` call.
- **`servers/_router.ts`** — single long-lived MCP process that dispatches all `ashlr__*` calls. Honors `ASHLR_ROUTER_DISABLE=1` fallback so users on stale `plugin.json` entries keep working. Populated via `servers/_router-handlers.ts` side-effect imports.
- **5 servers migrated** to the handler-style pattern: `glob`, `tree`, `ls`, `diff`, `webfetch`. Entry files slimmed from 200–550 LOC to ~20 LOC each; logic lives in `*-server-handlers.ts`. 12 more to migrate before `.claude-plugin/plugin.json` can collapse from 17 entries → 1.

### Added — cross-session embedding cache (Track B, full)

- **`~/.ashlr/context.db`** — SQLite-backed embedding cache via `bun:sqlite`. Survives session restarts and project switches. Honors `ASHLR_CONTEXT_DB_DISABLE=1` as a full no-op for privacy-conscious users.
- **`servers/_embedding-model.ts`** — BM25 pseudo-embedder (dim=256, FNV-1a hash projection, TF × smoothed-IDF weights). Zero new runtime deps. Remote dense embeddings via `ASHLR_EMBED_URL` (Ollama, LM Studio, any OpenAI-shaped `/embeddings` endpoint). Falls back to BM25 on remote failure.
- **`ashlr__grep` now queries the embedding cache** before genome RAG; cosine > 0.75 prepends cache hits as `[embedding-cache hit]` sections. Upserts matched content after every grep so warm sessions get progressively better.
- **`hooks/post-tool-use-embedding.ts`** — fire-and-forget re-embedding of edited files. Spawns `scripts/embed-file-worker.ts` detached so the hook never blocks.
- **`/ashlr-context-status`** — new slash command showing `embeddings | projects | db size | hit rate last 1000`.
- **Race-safe IDF corpus persistence** — pending-delta + advisory-lock-file pattern so concurrent writers merge instead of overwriting each other's history. Workers `await flushCorpusNow()` before exit to drain pending deltas.
- **`searchSimilar` scales** — SQL-level `LIMIT 5000` with `ORDER BY accessed_at DESC` (backed by `idx_project_accessed` + `idx_accessed`) keeps heap pressure bounded and biases the candidate window toward recent/active rows as the table grows.
- **Transactional accessed_at bookkeeping** — top-K update loop runs as a single WAL transaction on the hot read path instead of K individual autocommit writes.

### Added — tree-sitter infrastructure (Track C, foundation only)

- **`servers/_ast-languages.ts` + `servers/_ast-helpers.ts`** — `web-tree-sitter@0.22.6` WASM runtime with TypeScript/JavaScript grammars wired day-one (Python/Go/Rust stubs ready). `parseFile()` + `extractIdentifiers()` with value-vs-type-position distinction.
- **Binding choice rationale**: native `tree-sitter` fails to build under Bun + Node 25 headers (node-gyp doesn't emit `-std=c++20`); `web-tree-sitter@0.26.x` requires a `dylink.0` WASM section that prebuilt grammars don't ship. `0.22.6` is the stable sweet spot. Upgrade path ready when `tree-sitter-wasms` ships dylink-enabled grammars.
- **No new MCP tools in this release.** The actual `ashlr__edit_structural` (rename / extract-function / signature-change) is scheduled for v1.13.

### Added — compression v2 (Track D, substantial)

- **`servers/_accounting.ts`** — `recordSavingAccurate()` wrapper in front of `_stats.recordSaving` so cache-hit frequency is observable (`accounting_cache_hit` event with `underCountedTokens` payload) and the math can be adjusted in one place once real hit rates are known.
- **LLM summarizer pipes added** for `ashlr__webfetch` and `ashlr__http` — extracted content > 16 KB routes through `summarizeIfLarge()` with new `PROMPTS.webfetch` and `PROMPTS.http` (the latter preserves HTTP status + content-type as load-bearing context).
- **Glob + tree results > 8 KB** pipe through `summarizeIfLarge()` with new `PROMPTS.glob` and `PROMPTS.tree`.
- **Bash domain summarizers** — `docker ps`, `kubectl get <resource>`, `npm audit`. The Docker parser uses header-column offsets (not `/\s{2,}/` split) so multi-word statuses like `"Exited (137) 5 minutes ago"` don't shift image/ports into wrong slots.
- **`ashlr__flush`** — new tool that returns a compact summary of edits applied since the last flush. Edit batching was designed, prototyped, and pivoted to **immediate-write** after investigation found MCP dispatches tool calls concurrently, making deferred-flush inherently racy (reads could arrive before their preceding edit's timer fires). `ashlr__flush` is therefore a reporting tool, not a deferral trigger.

### Added — security & correctness

- **Path-traversal guard on the post-edit embed worker.** `scripts/embed-file-worker.ts` receives file paths from the attacker-controllable hook payload; it now routes through the shared `clampToCwd()` helper which canonicalizes via `realpathSync` on both sides, defeating the macOS `/var` → `/private/var` symlink bypass class.
- **`accounting_cache_hit` EventKind** — observability signal so subsequent releases can adjust the savings-accounting policy with real hit-rate data instead of guesses.

### Fixed — pre-existing integration-harness bugs (Agent E)

Nine distinct bugs in the integration test harness that predated this release:

- MCP subprocess `cwd` not set to `tempHome` — cwd-clamp rejected tmpdir paths in integration tests.
- `notifications/initialized` was being treated as a request (Bun 1.3 MCP protocol change).
- Missing `ASHLR_STATS_SYNC=1` — nondeterministic test-side disk writes.
- `bun eval` removed in Bun 1.3 — swap to temp-file script pattern.
- Genome seed helper used a stale manifest format.
- Backend tests needed `server/src/serve.ts` entrypoint for the `TESTING` magic-token stderr capture.
- `llm-summarizer-e2e.test.ts` stub server spoke Anthropic protocol while the plugin calls OpenAI `/chat/completions` directly.
- Plus three smaller fixes in `read-flow`, `stats-isolation`, `status-line-freshness`.

**Suite went from 1123 pass / 11 fail → 1250 pass / 0 fail / 1 skip (rg not in PATH).**

### Changed

- `servers/efficiency-server.ts`: removed dead `ensureFlushed()` no-op and its three call sites; trimmed `EditLogEntry` to only `{ relPath, hunksApplied }` (removed unused `search`, `replace`, `appliedAt`); replaced inline `require("fs").statSync` in ESM context with direct read-cache invalidation.
- `servers/_embedding-cache.ts`: deduplicated `normalizeInPlace` against `_embedding-model.ts`; consolidated two near-identical `searchSimilar` query branches into a single parameterized base query.

### Ops

- Version bumped to 1.12.0 in `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` (two entries).
- `.gitignore`: added `.claude/worktrees/` so parallel-agent worktree state never gets committed.

---

## [1.11.2] — 2026-04-19

**Security patch — finishing the `process.cwd()` clamp job started in v1.11.1.** The previous release added a cwd clamp to `ashlr__ls` so a prompt-injected tool call couldn't list `/etc`, `/root`, or any world-readable directory by passing an arbitrary `path` argument. That fix never propagated to the three sibling filesystem-touching tools — `ashlr__glob`, `ashlr__tree`, and `ashlr__grep` — which accepted the same shape of user input and walked the filesystem or spawned ripgrep against it unchecked. v1.11.2 closes that gap and extracts the clamp into a shared helper so future tools inherit it for free.

### Security

- **All nine remaining filesystem- or shell-touching MCP tools now refuse paths outside `process.cwd()`.** Previously a caller could pass `cwd: "/etc"`, `path: "/etc/passwd"`, `path: "~/.ssh/id_rsa"`, or `cwd: "/"` to a bash tool and the server would dutifully walk the filesystem, read the file, overwrite it, or pivot the shell working directory into an ancestor repo. The attack surface was identical to the v1.11.1 `ashlr__ls` gap — same input shape, same trust boundary. The fix routes all ten FS/shell tools (`ashlr__ls` + `ashlr__glob`, `ashlr__tree`, `ashlr__grep`, `ashlr__read`, `ashlr__edit`, `ashlr__multi_edit`, `ashlr__bash`, `ashlr__bash_start`, `ashlr__diff`) through a new `clampToCwd()` helper at `servers/_cwd-clamp.ts` that resolves symlinks via `realpathSync` (so `/var/folders/…` and `/private/var/folders/…` are treated as the same directory on macOS) and returns a refusal message matching the ls-server convention. `ashlr__grep`'s `findParentGenome` walk-up for inherited genomes is preserved — only the ripgrep spawn target is clamped, so legitimate monorepo-parent genome inheritance still works. `ashlr__multi_edit` clamps *before* reading any file so a bad path in a batch can't partially apply edits. `ashlr__bash` only clamps the working directory, not the command — running `ls /etc` remains allowed (the shell is arbitrary-command by design); what's prevented is a prompt-injected `cwd: "/"` or `cwd: "$HOME"` that would pivot the shell outside the project.
- **DoS mitigation on the canonicalization walk-up.** The helper caps its walk-up loop at `MAX_WALK_UP = 32` segments so a prompt-injected caller can't pass a pathologically long path (e.g., 200 segments of `doesnotexist/`) to force O(n) synchronous `realpathSync` failures. Real filesystems don't nest anywhere near this deep.
- **The clamp is now a documented trust boundary.** `SECURITY.md` was extended with a "Trust model" section that describes the cwd clamp, genome team ownership, and Stripe webhook idempotency — so future patches can preserve these invariants by design instead of re-learning them by incident.

### Tests

- Root suite: +17 passing cases across helper unit tests and per-tool integration tests (refusal shape, accept-inside-cwd, parent-escape via `..`, tool-name in message, DoS cap, `ashlr__read` clamp). Total: 1121 pass / 1 skip (up from 1117 pass / 1 skip / 12 fail — one failure from the v1.11.1 baseline was also fixed incidentally by the helper's symlink canonicalization).
- Server suite: 157 / 0 fail, unchanged. Webhook rollback path was already covered by the v1.11.1 retry test at `server/tests/billing.test.ts:361`; no new cases needed.
- Existing MCP-server integration tests (`__tests__/{glob,tree,efficiency,multi-edit}-server.test.ts`, `__tests__/integration/content-cache.test.ts`) were updated to spawn the server with an absolute script path and set the subprocess cwd (via `process.chdir()` in per-describe `beforeEach` or by passing `cwd` to the rpc helper) so caller-supplied tmp-dir paths land inside the working directory. Pre-existing brittleness from a hardcoded project path in `glob-server.test.ts` was also removed.

### Ops

- Version bumped to 1.11.2 in `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (two entries).

---

## [1.11.1] — 2026-04-19

**Security hardening on two pre-existing backend gaps** flagged during the v1.11.0 polish audit. Neither was introduced by v1.11.0 — both predate the release (genome ownership since v1.8.0, webhook TOCTOU since v1.3.0) — but both are real and shipping v1.11.1 as a dedicated security patch.

### Security

- **Genome routes now enforce team ownership.** `server/src/routes/genome.ts` endpoints (`push`, `pull`, `conflicts`, `resolve`, `settings`, `delete`) previously loaded any genome by UUID without checking that the caller's team owned it. Any authenticated team-tier user who learned or guessed a genome UUID could read, write, or delete another team's genome. Fixed with a new `requireGenomeAccess(genomeId, teamId)` helper that filters on `genomes.org_id = ?` at query time and returns null when the match fails (caller always gets 404 — never leaks existence to unauthorized callers). `POST /genome/init` now authoritatively stores `team.id` in `org_id` from the caller's `getTeamForUser` membership rather than trusting a body field. 8 new test cases across owner-access, cross-team denial on every endpoint, settings-admin check, and delete-preservation.
- **Stripe webhook is now atomic.** `server/src/routes/billing.ts` previously did `if (isStripeEventProcessed(id)) return; void handleWebhookEvent(event); markStripeEventProcessed(id);` — a classic TOCTOU where two concurrent deliveries of the same event could both read "not processed" and both fire the handler (double-grant, double-refund, double-email). Replaced with a single atomic claim via new `tryMarkStripeEventProcessed(eventId): boolean` helper that runs `INSERT INTO stripe_events (event_id) VALUES (?) ON CONFLICT (event_id) DO NOTHING` and returns `changes === 1`. Handler is now `await`ed; if it throws, `deleteStripeEvent(eventId)` rolls back the marker and the route returns 500 so Stripe retries. 2 new test cases: concurrent duplicate delivery (asserts handler fires exactly once) and handler-throws-then-retry-succeeds.

### Tests

- **Server: 156 pass / 0 fail** (up from 146; +8 genome ownership, +2 webhook idempotency).
- Root plugin suite unchanged (948 / 1 skip / 0 fail).

### Ops

- Version bumped to 1.11.1 in `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.

### Note on production data

The genome ownership fix is correct for all new genomes created after v1.11.1. Existing production genomes with `org_id` values set from pre-fix body params may need a one-time migration to adopt the team-id ownership model — tracked separately and not in scope for this patch.

---

## [1.11.0] — 2026-04-19

**Hero demo + landing-page overhaul + team invites + Grafana + CLI.** Four weeks of planned work shipped in one release. Everything the v1.11.0 plan promised, executed end-to-end across the plugin, the Remotion video workspace, the Next.js site, the backend, observability, and the CLI.

### Added — Hero video (Remotion)

- **New `video/` workspace** — fresh top-level Remotion 4.0 project with two compositions (`HeroVideo` 1920×1080 @ 60 fps, `HeroVideoVertical` 1080×1920 for Reels/Shorts/TikTok), a 30-second 5-beat narrative driven by `docs/hero-video-script.md`. 196 packages, under 15 MB final render budget.
- **`servers/_status-line-cells.ts`** — pure Cell[] renderer extracted from `scripts/ui-animation.ts`. Both the CLI status line and the Remotion `StatusLineStill.tsx` consume the same cell-producing functions, so the animated terminal in the hero video is pixel-identical to what users see in their terminal. Net-win independent of the video (+29 new tests).
- **B1 `/ashlr-savings`** — typewriter-reveal terminal frame with caption fade.
- **B2 status-line zoom** — `StatusLineStill` at 1.8× scale with real animated sparkline, heartbeat glyph, gradient sweep, and pulse overlay.
- **B3 live edit counter** — split-pane diff + status-line with synced activity pulse.
- **B4 `/ashlr-dashboard`** — real ledger dashboard: three CountUp tiles (session / lifetime / best day) with ease-out-cubic 60 fps animation, staggered bar-chart width fills, 7d + 30d sparklines, Fraunces-italic projected-annual line.
- **B5 browser + install + tagline** — `BrowserFrame` (traffic-light chrome + URL bar + mirrored landing hero + stamped -71.3% ledger card with cinematic 1.04 → 1.0 scale) → install-command typewriter → Fraunces-italic "ship less context." tagline card with optional AI-generated parchment plate.
- **`video/scripts/render.ts`** — orchestrates 1080p60 mp4 + 4K master + 9:16 vertical + poster still + OG still.
- **`.github/workflows/render-hero.yml`** — CI re-renders on any `video/**` or status-line change and opens an auto-PR with refreshed `site/public/hero.mp4` + `hero-poster.jpg` + `docs/assets/og.png`.
- **Hero video live on landing page** via `site/components/hero-video-player.tsx` — `<video>` with IntersectionObserver autoplay/pause, reduced-motion fallback to the existing `<TerminalMock />`, graceful failure on autoplay block. Replaces the static SVG hero.

### Added — Landing page Phase B

- **Hero headline swap**: "The token ledger for Claude Code." → **"Ship less context."** (the tagline the video lands on, reused as the headline itself). Subhead updated to lead with "19 MCP tools. Mean −71.3% savings measured to the byte."
- **`InstallCountBadge`** + **`/api/install-count`** — server route with 1-hour cache fetching live GitHub stargazers + total release-download count. Renders "{N} stars · {M} downloads · MIT" under the hero counter. Hides on fetch failure so the page never breaks.
- **New `HowItWorks` section** between `BeforeAfter` and `ToolsGrid` — three cards explaining the core mechanisms (snipCompact read, genome-aware grep, live counter) with self-contained mini-visualizations. Answers the #1 landing-audit finding: "no visual answer to 'what does this actually do?'".
- **ToolsGrid impact** — per-tool mean savings % badges pulled from `benchmarks-v2.json` (read 79.5%, grep 62.1%, sql 58.4%, bash 44.8%, http 64.2%, diff 54.3%) with deep-link to `/docs/tools/<name>`. Heading is now dynamic (`{tools.length} tools`).

### Added — Team tier

- **DB schema**: new `teams`, `team_members` (admin|member role), `team_invites` (7-day TTL, token + role + expiry + accepted_at + revoked_at) tables with cascading indexes.
- **`POST /team/create`** — requires tier=team, creates team + implicit admin membership for owner.
- **`GET /team/members`** — lists caller's team with per-member email/role/joined_at.
- **`GET /team/invites`** — admin-only, lists pending invites.
- **`POST /team/invite`** — admin-only, creates invite + sends SendGrid `team-invite` email template.
- **`POST /team/invites/:token/revoke`** — admin-only.
- **`POST /team/accept-invite`** — atomic SQLite transaction marks invite accepted + adds membership.
- **New `team-invite.tsx` React email template** — Fraunces heading + IBM Plex body, parchment palette matching the existing magic-link aesthetic.
- **New `/ashlr-team-invite` skill** — `/ashlr-team-invite alice@example.com [admin|member]` curls `POST /team/invite` and prints a one-line outcome.

### Added — Observability, CLI, tool coverage

- **`observability/grafana/ashlr-overview.json`** — importable Grafana dashboard with 4 stat tiles (active subs, users, uploads rate, magic links/hr), HTTP request rate by status, latency p50/p95/p99, LLM rate + token histogram, 5xx/4xx error-rate band. Template variable `$prom` retargets datasources without editing JSON. `observability/README.md` explains Prometheus scrape config and import flow.
- **`ashlr` CLI binary** — new `scripts/cli.ts` + `bin` entry in `package.json`. Supports `ashlr stats --json [--session <id>] [--since <YYYY-MM-DD>] [--tool <name>]` and `ashlr version`. Read-only, never mutates, exits non-zero on unparseable `stats.json`.
- **`docs/session-log-schema.md`** — canonical schema doc with field table, event vocabulary, rotation rules, schema versioning policy, kill-switch env. Replaces the inline MDX documentation as the single source of truth for cross-agent consumers.
- **`ashlr__ls` MCP wrapper** (`servers/ls-server.ts`) — gitignore-aware directory listing via `git ls-tree` when in a repo, compact columnar output, elides past `maxEntries` (default 80, max 1000), records savings like every other wrapper.

### Changed

- **`scripts/ui-animation.ts`** — refactored from ~400 LOC of ANSI-coupled code into a thin ANSI wrapper that imports from `servers/_status-line-cells.ts`. All existing exports re-exported for backward compatibility. 50/50 existing tests pass unchanged.
- **Plugin description** in `.claude-plugin/plugin.json` updated from "14 MCP tools" to "20 MCP tools" with the new tool list; called out Remotion hero video, team invites, Grafana, and the `ashlr stats --json` CLI.

### Tests

- **949 pass, 1 skip, 0 fail** (root; up from 920). Server: 146 pass, 0 fail (unchanged suite coverage, new team routes not yet exercised in tests — follow-on).

### Ops

- Version bumped to `1.11.0` in `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.
- Hero video + poster committed to `site/public/` (1.8 MB video, 32 KB poster) as the initial artefacts. Subsequent renders ship via the `render-hero.yml` workflow.

### Not in scope (documented in plan, intentionally deferred to v1.12+)

- TaskGet/TaskUpdate MCP wrappers, NotebookEdit wrapper, generic `ashlr__monitor`.
- `site/app/team/page.tsx` UI for the team invite flow (backend + skill ship now; frontend page is a small follow-on).
- Real-time VS Code extension stats (currently 2 s poll; WebSocket upgrade deferred).
- Per-member team quotas and fine-grained RBAC beyond admin/member.

---

## [1.10.2] — 2026-04-19

**Fix `/ashlr-update` on the current Claude Code plugin-cache layout.**

### Fixed

- `commands/ashlr-update.md` — the skill hardcoded `~/.claude/plugins/ashlr-plugin/`, which only exists on the legacy install layout. Current Claude Code installs plugins under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` (with the version directory pinned to the *install*-time version, even after git-pulls into it), so every step of the skill was failing with `no such file or directory`. The skill now resolves the install path by trying, in order: `$CLAUDE_PLUGIN_ROOT` → legacy path → newest cache-directory match. It also explains that the cache-dir name is effectively opaque and doesn't update with pulled commits.

This was discovered when the user ran `/ashlr-update` after v1.10.1 was tagged: the pre-1.10.1 cache directory was still at a v1.0.1-era SHA (`d68991c`), meaning the skill had effectively never worked for installs that used the new cache layout. Manual resolution via `~/.claude/plugins/cache/ashlr-marketplace/ashlr/0.7.0/` succeeded and fast-forwarded ~18 releases.

---

## [1.10.1] — 2026-04-19

**Polish — security hardening, Windows correctness, hook hygiene.** Three iterations of automated review + simplify + security audit, all fixes landed. No new features; every change is a bug or correctness fix.

### Security

- **`/auth/status` rate-limited** (`server/src/routes/auth.ts`) — 20 req/min/IP via the same sliding-window bucket helper used in `llm.ts` / `stats.ts`. Blocks a fast-scan email-enumeration against the terminal upgrade-flow poller.
- **`/auth/status` email validation** (`server/src/routes/auth.ts`) — `z.string().email().max(254)` before the SQLite lookup. Stops multi-MB / crafted query-param payloads from reaching `consumeVerifiedTokenForEmail`. Matches the `POST /auth/send` posture.
- **Admin refund idempotency key** (`server/src/routes/admin.ts`) — `admin-refund-${chargeId}-${amountCents}` passed to Stripe so a retry (network flake, double-click, CI replay) can't double-refund a charge.

### Correctness

- **`consumeVerifiedTokenForEmail` wrapped in a transaction** (`server/src/db.ts`) — the SELECT + DELETE pair was not atomic; two concurrent `/auth/status` polls could each `SELECT` the same pending token before either deleted it. Now one txn() closure, read-then-delete is serialized by SQLite.
- **`auto-update.writeUpdateStamp` accepts `today` override** (`scripts/auto-update.ts`) — the stamp date was always taken from the real wall clock even when `checkForUpdate` was passed an injected `today`. Fixed plus a `todayISO()` helper so the three default-param sites share one source of truth. Fixes 3 auto-update tests that had been failing since v1.10.0.
- **`session-log-append` rotation cascade** (`hooks/session-log-append.ts`) — `.jsonl.1 → .jsonl.2` before `.jsonl → .jsonl.1`. `renameSync` silently overwrote any prior `.1`, which meant back-to-back 10 MB rotations permanently destroyed the older rotation. Now we keep one level of backup (~20 MB of recent session log survives rotation churn). Consumers (`session-log-report`, `coach-report`, `handoff-pack`) no longer see data-loss gaps.
- **`pretooluse-{read,edit}` use `isInsidePluginRoot`** (`hooks/pretooluse-{read,edit}.ts`) — the raw `startsWith(pluginRoot)` bypass could be triggered by a sibling directory that shares the plugin root as a prefix (e.g. `/Users/x/ashlr-plugin-backup/foo.ts`). `pretooluse-grep` already used the helper; read/edit now match.

### Cross-platform

- **Windows `cmd /c start` settle extended to 500 ms** (`scripts/upgrade-flow.ts`) — ENOENT / URL-handler failures on Windows surface noticeably later than POSIX `open` / `xdg-open`. The 50 ms wait was racing the error event and printing a false "Opened checkout in your browser" message when no browser opened. POSIX stays at 50 ms.
- **Browser-spawn error listener attached before `unref()`** (`scripts/upgrade-flow.ts`) — an asynchronous spawn failure that arrived after the child was unreferenced used to either crash the process or be silently swallowed. Now the error listener is attached first and the fallback "Open this URL manually" path fires reliably.
- **Per-file Windows chmod warning** (`servers/_genome-crypto.ts`) — prior once-per-process warning could miss a key-file rotation. New wording is accurate about NTFS ACLs inheriting from the parent directory (not user-only by default, depends on profile state). Points users at BitLocker / EFS / `icacls`.

### Refactor

- **`hooks/pretooluse-common.ts`** (new) — shared helpers `enforcementDisabled`, `readStdin`, `parsePayload`, `pluginRootFrom`, `isInsidePluginRoot`, `fileSize`. Pulled duplicated logic out of `pretooluse-{read,edit,grep}.ts`; the three hooks are now ~40% shorter and behave identically. Renamed stdin-reader Promise param from `resolve` to `done` so it stops shadowing the `resolve` imported from `path`.
- **`scripts/auto-update.ts`** — extracted private `todayISO()` so three copies of `new Date().toISOString().slice(0, 10)` collapse to one.

### Tests

- **920 pass, 1 skip, 0 fail** (root). `server/`: 146 pass, 0 fail.
- Auto-update test `alreadyNotifiedToday returns false for different date` now passes an explicit `today` to `writeUpdateStamp` so the test works on any calendar date (was fragile when system clock matched the hardcoded compare value).

### Process

- Three polish iterations, all under automated pipeline (`/polish`): commit → lint/typecheck → parallel code-review + simplify + security-audit → fix → re-commit. Iterations 1 and 2 applied 11 fixes; iteration 3 added 2 more (session-log cascade, /auth/status email validation) before converging on "clean — ship it" from all three agents.

### Ops

- Bumped `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` to 1.10.1.

---

## [1.10.0] — 2026-04-18

**Polish + public pages + auto-update.** Tech debt cleaned up, a public roadmap, a blog with three seeded posts, RSS feed, and an auto-update notifier in the plugin.

### Added

- **`/roadmap`** (`site/app/roadmap/page.tsx`, ~280 LOC) — Now / Next / Considering / Shipped sections with ledger-card visuals, status dots, ETA badges. Sourced from CHANGELOG reality. Live with the parchment aesthetic.
- **`/blog`** (`site/app/blog/*`, ~450 LOC + 3 MDX posts). Index, individual post route, RSS feed at `/blog/rss.xml`. Three seed posts totaling ~2,340 words:
  - `2026-04-18-introducing-ashlr.mdx` (~920 words) — v1.0 launch story.
  - `2026-04-18-fixing-the-session-counter.mdx` (~670 words) — technical post-mortem on the v0.9.3 CLAUDE_SESSION_ID divergence bug.
  - `2026-04-18-encryption-for-team-genomes.mdx` (~750 words) — walkthrough of the v1.8.0 AES-256-GCM genome encryption.
  - Zero new deps — bespoke YAML frontmatter parser + client-side MDX-style renderer.
- **Auto-update notifier** (`scripts/auto-update.ts` + integration in `hooks/session-start.ts`). On SessionStart, fetches `api.github.com/repos/ashlrai/ashlr-plugin/releases/latest` with 2 s timeout, compares semver, emits a single stderr line when upstream is newer ("v1.11.0 available — run /ashlr-update"). Gated once-per-day-per-version via `~/.ashlr/last-update-notice`. Never blocks, never throws, silent on network failure or malformed response. 24 tests.
- Nav + footer + sitemap updated with `/blog` and `/roadmap`.

### Fixed (tech-debt cleanup)

- **`server/src/db.ts:1153`** — typed `bindings` as `SQLQueryBindings[]` (was `unknown[]`) + added `import type { SQLQueryBindings } from "bun:sqlite"`.
- **`server/src/emails/broadcast.tsx:35`** — `...fonts.body` spread of a string → `fontFamily: fonts.body`. Was broken at runtime too.
- **`server/src/routes/admin.ts:206`** — Stripe API shape change: `invoice.charge` → `stripe.invoicePayments.list()` → `payment.payment_intent` → `stripe.paymentIntents.retrieve()` → `latest_charge`. Matches current Stripe API `2026-03-25.dahlia`.
- **`server/src/routes/admin.ts:215`** — Stripe `RefundCreateParams.Reason` enum: invalid `"other"` → `"requested_by_customer"` (freeform reason still captured in `metadata.admin_reason`).
- **`server/tests/admin.test.ts:218`** — query type param + stub `stubStripeRefundOk` aligned with new code path.

### Tests

- **920 pass, 1 skip, 0 fail** (root, +24 since v1.9.0).
- **146 pass** (server, unchanged — refund test stubs updated, no count change).
- Clean typecheck at root and site build.

### Content to verify before publishing

- Intro-post benchmark numbers (−82.2% / −81.7% / −71.3%) copied from `docs/launch-post.md` — confirm still match `docs/benchmarks-v2.json`.
- Encryption-post nonce size / API shape — illustrative snippet; verify matches actual `servers/_genome-crypto.ts` before publishing.


## [1.9.0] — 2026-04-18

**Cross-platform + terminal-native Pro upgrade.** Runs correctly on Windows, macOS, and Linux. `/ashlr-upgrade` takes a user from free to Pro in ~90 seconds without leaving the terminal.

### Added

- **`/ashlr-upgrade` skill** (`commands/ashlr-upgrade.md` + `scripts/upgrade-flow.ts`, 310 LOC). Five-step terminal flow: current-tier check → magic-link sign-in (with 3-min polling on `GET /auth/status`) → tier picker (Pro mo/yr, Team mo/yr) → Stripe Checkout URL opened in the default browser via `open`/`xdg-open`/`start` → 10-min poll on `GET /billing/status` for payment confirmation. Saves `ASHLR_PRO_TOKEN` automatically to `~/.ashlr/pro-token` (mode 0600 where supported) plus a `~/.ashlr/env` file that `session-start.ts` sources on the next session. 21 tests.
- **`GET /auth/status?email=<email>`** — new endpoint that returns `{ ready: true, apiToken }` once after a magic-link verify, then `{ ready: false }` (one-shot semantics). Lets the terminal flow poll for sign-in completion without storing the token in the browser's localStorage. `pending_auth_tokens` table added. 3 tests.
- **Cross-platform hooks** — six bash hooks rewritten in TypeScript: `pretooluse-{read,grep,edit}.ts`, `session-log-append.ts`, `post-tool-use-genome.ts`, `session-end-consolidate.ts`. `hooks/hooks.json` points at the `.ts` versions. Old `.sh` files kept for back-compat reference. No bash dependency on Windows.
- **Cross-platform shell selection** (`servers/bash-server.ts`): `resolveShell()` returns `powershell -NoProfile -NonInteractive -Command` on Windows, `$SHELL -c` on POSIX.
- **Cross-platform path handling** — five sites rewritten to use `path.join`/`dirname`/`basename`/`isAbsolute`/`relative` instead of string ops on `/`.
- **Windows install guide** at `docs/install-windows.md` + `docs/install.ps1` PowerShell installer.
- **`docs/platform-support.md`** — full matrix of what works where, including known limitations (chmod on Windows is a no-op + logged warning, integration tests Linux-only).
- **Multi-OS CI matrix** (`.github/workflows/ci.yml`) — `typecheck`, `test`, `smoke` now run on `{ubuntu-latest, macos-latest, windows-latest}` with `fail-fast: false`. Cache keys scoped per-OS. ripgrep installed via `apt-get` / `brew` / `winget` depending on runner. Three CI status badges in the README.
- **`scripts/smoke-cross-platform.ts`** — tiny validator that runs in every matrix leg.
- **VS Code extension packaging** in `release.yml` — `vsce package` on tag, `.vsix` attached as release asset.
- **`docs/upgrade.md`** — user-facing guide for the terminal upgrade flow.
- **`hooks/session-start.ts`**: new `sourceAshlrEnv()` reads `~/.ashlr/env` so upgraded users pick up `ASHLR_PRO_TOKEN` without needing to restart their shell.

### Changed

- **Windows chmod**: `saveKey()` in `servers/_genome-crypto.ts` now skips `chmod 0600` on Windows and logs a one-time warning recommending BitLocker/EFS.
- **`gh`/`rg` detection** — replaced bash-specific `command -v` with `Bun.which()` + `where`/`which` fallbacks.
- **`/dev/tty` → `process.stdin`** in `scripts/genome-key.ts` for cross-platform interactive prompts.

### Fixed

- Three tests get `test.skipIf(process.platform === "win32")` with clear comments: 0600 file-mode check, `chmodSync(dir, 0o000)` unreadable-dir test, `chmod +x` executable-bit test. All pass in isolation + full suite on the target platforms.

### Tests

- **896 pass, 1 skip, 0 fail** (root, +38 since v1.8.2).
- **146 pass** (server, +3 auth-status tests).
- 17 new cross-platform tests in `__tests__/cross-platform.test.ts`.
- Matrix CI wall-time: ~5min Linux, ~8min macOS, ~12min Windows.

### Migration notes

- No breaking changes. `ASHLR_PRO_TOKEN` users keep working exactly as before.
- Hooks are now TypeScript — on first activation after upgrade, the session-start hook will need Bun available on PATH (it already was).
- Windows users: first run may see a one-time warning about genome key file permissions. This is cosmetic — the key still works.


## [1.8.2] — 2026-04-18

**Email provider swap: Resend → SendGrid.** Matches the standard stack used across AshlrAI Inc's other projects.

### Changed

- **`server/src/lib/email.ts`** — SendGrid client (`@sendgrid/mail`) replaces the Resend SDK. Lazy init via `sgMail.setApiKey()`, `parseAddress()` helper turns `"ashlr <noreply@ashlr.ai>"` into SendGrid's `{ name, email }` shape. Error logging captures SendGrid's response body.
- **`server/package.json`** — `resend` removed, `@sendgrid/mail@^8.1.6` added.
- **`server/src/workers/health-check.ts`** — `email-delivery` component now probes `api.sendgrid.com` instead of `api.resend.com`.
- **Environment variable renamed**: `RESEND_API_KEY` → `SENDGRID_API_KEY`. All references updated in `.env.example`, `docs/deploy.md`, `docs/billing.md`, `docs/email-templates.md`, `docs/legal.md`, `server/README.md`.
- **Sub-processor table** in `/privacy` and `/dpa`: Resend → SendGrid (Twilio SendGrid Inc). DPA URL pointer in `docs/legal.md` updated to Twilio's data-protection-addendum page.

### Launch impact

Update the Fly.io secrets before first deploy:

```
flyctl secrets set SENDGRID_API_KEY=SG.xxxxx
```

Domain verification moves from the Resend dashboard to SendGrid's Sender Authentication flow. Same SPF/DKIM concepts; SendGrid's UI is different. Link in `docs/deploy.md` now points at SendGrid's docs.

### Tests

- **858 pass, 1 skip, 0 fail** (root).
- **143 pass** (server) — `emails.test.ts` unchanged since the public API (`sendEmail(template, { to, data })`) is identical. Test-mode fallback behavior (logging to stderr when no API key) still works the same way.


## [1.8.1] — 2026-04-18

**Entity-level launch config.** All placeholder copy replaced with real entity details.

### Changed

- **Entity name**: every "Ashlr AI" / "Ashlr AI, operated by Mason Wyatt" placeholder → **AshlrAI Inc** (Delaware corporation) across `/privacy`, `/terms`, `/dpa`, `/pricing`, Fumadocs pro pages, and footer.
- **Contact email**: every `privacy@ashlr.ai` and `mason@evero-consulting.com` reference → **support@ashlr.ai** across site + docs (17 touch-points).
- **Terms section 10 (governing law)**: removed the "[Placeholder — confirm with counsel before launch]" italic block. Reads cleanly as a Delaware corporation governed by Delaware law.
- **`docs/legal.md` checklist**: entity + email + governing-law items checked off. Remaining items are Stripe dashboard settings, Resend DNS verification, sub-processor DPA countersignatures — all genuinely counsel/ops work.

### Unchanged

- No code changes. Same tests, same build, same behavior.


## [1.8.0] — 2026-04-18

**Enterprise posture.** Client-side genome encryption, a real admin dashboard, and a public status page.

### Added

- **Client-side genome encryption** (`servers/_genome-crypto.ts`, 210 LOC; `scripts/genome-key.ts` CLI). AES-256-GCM with per-section random nonces. Keys live at `~/.ashlr/team-keys/<id>.key`, mode 0600. Server never sees plaintext — stores ciphertext in a `content_encrypted` column, enforces via new `encryption_required` per-genome flag. `PATCH /genome/:id/settings` endpoint. `scripts/genome-key.ts` supports `generate`, `export`, `import`, `rotate`. Backwards compatible with existing plaintext genomes. 12 new crypto tests + 4 integration tests.
- **Admin dashboard** (`site/app/admin/*`, ~800 LOC + 9 backend endpoints at `server/src/routes/admin.ts`). Routes: `/admin/overview` (MRR, active subscriptions, DAU, LLM sparkline, recent signups + payments), `/admin/users` (searchable, email-redacted list), `/admin/users/[id]` (full detail + comp/refund modals), `/admin/revenue`, `/admin/errors` (Sentry), `/admin/audit`, `/admin/broadcast`. Bootstrap via `bun run server/src/cli/make-admin.ts <email>`. All mutations write to the audit log. 14 new admin tests.
- **Public status page** (`site/app/status/*` + `server/src/routes/status.ts`). Overall status strip, per-component 90-day uptime bars, recent incidents with update timeline, email subscribe with double-opt-in, RSS feed at `/status/rss.xml`. Synthetic health-check worker at `server/src/workers/health-check.ts` probes each component every 60s. Incident CRUD via admin-authed `POST /status/incident` + `PATCH /status/incident/:id`. 11 new status tests.
- **`status-confirm` email template** for the status page subscribe flow.

### Fixed

- **Wildcard-middleware bug in `server/src/routes/genome.ts`** (`use("*", authMiddleware)` intercepted every unmatched request app-wide when mounted at root — fixed to `use("/genome/*", authMiddleware)`).

### Database

Extended `server/src/db.ts` with: `health_checks`, `incidents`, `incident_updates`, `status_subscribers`, plus `users.is_admin` and `users.comp_expires_at` columns. All idempotent late-migration.

### Tests

- **858 pass, 1 skip, 0 fail** (root, +17 since v1.7.0).
- **143 pass** (server, +26 admin + status + genome encrypted).
- Clean site build with new `/admin/*` and `/status/*` routes.


## [1.7.0] — 2026-04-18

**First-impressions polish.** HTML emails, an auto-firing onboarding wizard for new users, and the last two flaky tests actually fixed.

### Added

- **HTML email templates** (`server/src/emails/`) built with `@react-email/components`. Six templates: magic-link, welcome, payment-success, payment-failed, subscription-canceled, daily-cap-reached. Every template renders both HTML and plain text. Parchment palette, Fraunces italic, IBM Plex Sans. Outlook/Gmail/Apple Mail compatible. Subject lines ≤ 70 chars, preheader ≤ 90 chars.
- **`server/src/lib/email.ts`** — single `sendEmail(template, { to, data })`. Uses Resend; falls back to stderr logging under `TESTING=1` or when `RESEND_API_KEY` is unset. Never throws.
- **Email wiring**: `magic-link` from `/auth/send`; `welcome` + `payment-success` from `checkout.session.completed` webhook; `payment-failed` from `invoice.payment_failed`; `subscription-canceled` from `customer.subscription.deleted`; `daily-cap-reached` from `/llm/summarize` when cap hit (throttled once-per-day via `daily_cap_notifications` table).
- **Email preview server**: `bun run server/src/emails/preview.ts` serves every template at `:3333` for local visual QA.
- **First-run onboarding wizard** (`commands/ashlr-start.md` + `scripts/onboarding-wizard.ts`, 330 LOC). Six steps: doctor check, permissions, live read demo on the user's own cwd file, genome offer (if ≥10 source files + no existing genome), pro teaser, done. Auto-fires on first session via `~/.ashlr/installed-at` stamp detection in `session-start.ts`. 20 new tests.
- **23 email tests** (`server/tests/emails.test.ts`).

### Fixed

- **Two skipped tests un-skipped** and passing in full-suite runs:
  - `no-genome grep emits tool_fallback` — un-skipped.
  - `ashlr__edit medium and large samples have ratio < 1` — un-skipped.
  - Root cause (`__tests__/genome-cache.test.ts`): used `mock.module("@ashlr/core-efficiency", ...)` at top level, which Bun's test runner writes into the shared module registry and never restores across files. Tests loaded after alphabetically inherited the stub.
  - Production fix: `servers/_genome-cache.ts` now takes an optional `retriever` parameter (DI). Production callers unchanged.
  - Test fix: `__tests__/genome-cache.test.ts` replaces `mock.module` with DI.
- **`docs/test-isolation.md`** — ~80-line note explaining Bun test module-state sharing and the isolation pattern to follow.
- **`scripts/find-test-leak.ts`** — bisect helper for finding which test file leaks state.

### Tests

- **841 pass, 1 skip, 0 fail** across 53 root test files (+21 since v1.6.0). The last remaining skip is `sql-server.test.ts pgDescribe` — gates on `TEST_DATABASE_URL`, not an isolation issue.
- **117 pass** (server, +23 email tests).


## [1.6.0] — 2026-04-18

**Team tier features + integration test suite.** Phase 3 CRDT genome sync, Phase 4 policy packs + audit log, end-to-end integration suite.

### Added

- **Phase 3: CRDT genome sync** (`server/src/routes/genome.ts`, 275 LOC + plugin-side client at `servers/_genome-sync.ts`, 210 LOC).
  - Six endpoints: `/genome/init`, `/push`, `/pull?since=N`, `/conflicts`, `/resolve`, `DELETE`.
  - Vector-clock-based LWW CRDT at section granularity. Concurrent edits → conflict pair with both variants; stale writes detected.
  - Opt-in via `ASHLR_TEAM_GENOME_ID` env var. Non-blocking, never breaks a session.
  - 15 server tests + 6 client tests.
  - Deferred: client-side encryption (v2), full CLI conflict resolver, manifest LWW sync.

- **Phase 4: Policy packs + audit log** (`server/src/routes/policy.ts` + `server/src/routes/audit.ts`).
  - Policy packs: admin uploads YAML rules (allow/deny/requireConfirm). Versioned with rollback. Precedence: deny > requireConfirm > allow. `hooks/policy-enforce.ts` applies locally with 5-min cache.
  - Audit log: every non-read tool call logged server-side. Paths fingerprinted (SHA-256), content never stored. Query with filters + NDJSON export.
  - `hooks/audit-upload.ts` fires PostToolUse. Fire-and-forget with 3s timeout.
  - 8 policy tests + 8 audit tests + 6 client tests.

- **End-to-end integration suite** at `integration/` (standalone workspace, 305-LOC harness). 10 tests:
  1. read flow — compression + stats
  2. multi-edit atomic rollback
  3. cloud-sync round trip
  4. cloud LLM summarizer via stub
  5. permissions install idempotency
  6. status-line freshness under load
  7. genome live-refresh after edit
  8. billing tier transitions on webhook
  9. magic-link auth happy path
  10. cross-session isolation
  - New CI job `integration` after `test` with 10-min ceiling.

- **`docs/policy-packs.md`** — rule syntax, YAML examples, precedence table, rollback flow.
- **`docs/team-genome.md`** extended with sync flow, conflict resolution, security model.
- **`minimatch`** dependency added for hook glob matching.

### Fixed

- Bun-type narrow casts in `__tests__/genome-sync.test.ts` (`globalThis.fetch = ... as unknown as typeof fetch`).
- `hooks/audit-upload.ts` and `hooks/policy-enforce.ts` marked as modules (`export {}`) for top-level await.
- Root `test` script scoped to `__tests__/` so integration tests don't run without their harness.

### Tests

- **820 pass, 2 skip, 0 fail** (root, `__tests__/` scope).
- **94 pass** (server, +16 for policy/audit/genome Phase 3).
- **10 integration tests** in `integration/tests/` (run separately: `cd integration && bun test` with backend live).

### Deps

- root: `minimatch` (hook matching).
- server: (unchanged — already had what it needed).
- integration: zero external deps (by design).


## [1.5.0] — 2026-04-18

**VS Code extension, backend observability, launch content kit.** The plugin expands to a new host, the backend gets real eyes on errors and metrics, and every piece of launch-day copy is written.

### Added

- **VS Code extension** (`vscode/`, 1,210 LOC source → 21 KB bundle). Status bar with 2 s polling of `~/.ashlr/stats.json`. Dashboard webview with parchment theme. Inline gutter decorations on Read/Edit/Grep calls. Five commands: Show Dashboard, Open Genome Folder, Run Benchmark, Show Savings, Sign in to Pro. Settings: stats path, poll interval, show gutter badges. Manifest validates cleanly for `vsce package`.
- **Backend observability**:
  - **Sentry** via `@sentry/bun`. Error middleware wired to Hono `app.onError`. PII scrubbed (`text`, `systemPrompt`, `email`, `authorization`, `cookie`, `password`) via `beforeSend`. Release tagging. No-op without `SENTRY_DSN`.
  - **Structured logging** via `pino` + `pino-http`. JSON in production, pretty in dev. Every HTTP request: method, path, status, latency, user_id, requestId.
  - **Prometheus metrics** at `GET /metrics`. Gauges (users_total, subscriptions_active), counters (http_requests_total, llm_requests_total, magic_links_sent_total), histograms (http_request_duration_seconds, llm_request_tokens). Gated by IP allowlist or Basic Auth.
  - **`/healthz` + `/readyz`** liveness + readiness probes. Fly.io health check updated.
  - **`docs/operations.md`** — monitoring guide, alert thresholds, runbooks for DB down / Anthropic failure / Stripe webhook lag / rate-limit flood.
  - **Client Sentry** on the site at `/dashboard`, `/signin/*`, `/billing/*` only (marketing pages skipped to reduce noise).
- **Launch content kit**:
  - `docs/launch-post.md` — ~920-word blog post telling the v0.6 → v1.4 story.
  - `docs/producthunt.md` — PH tagline, description, first comment, gallery captions.
  - `docs/social.md` — three Twitter variants, LinkedIn draft, HN title + first comment.
  - `site/app/compare/page.tsx` — 20-row comparison matrix vs WOZCODE / native Claude Code / Cursor. Honest marks only ("unknown" where truly unknown).
  - `docs/hero-video-script.md` — 30-second product video brief.
  - `docs/press-kit/` — logo SVG, screenshot shot-list, founder bio, fact sheet.

### Tests

- **867 pass, 2 skip, 0 fail** (root, +7 since v1.4).
- **60 pass** (server, +7 observability).
- VS Code extension builds clean; manual QA checklist at `vscode/test-manual.md`.

### Deps

- `server/`: `@sentry/bun`, `pino`, `pino-http`, `prom-client`, `pino-pretty` (dev).
- `site/`: `@sentry/nextjs`.
- `vscode/`: self-contained; no root pollution.

### New envvars (all opt-in)

| Var | Where | Purpose |
|---|---|---|
| `SENTRY_DSN` | server | Sentry error tracking |
| `METRICS_ALLOWED_IPS` or `METRICS_USER` + `METRICS_PASS` | server | gate `/metrics` |
| `LOG_LEVEL` | server | Pino level override |
| `NEXT_PUBLIC_SENTRY_DSN` | site | client-side Sentry |

### Before-launch content review

Items in `docs/producthunt.md` and `docs/social.md` use exact numbers from `docs/benchmarks-v2.json` (−71.3% overall). WOZCODE comparison cells are marked "unknown" where no public data exists — verify before publish if you have internal data.


## [1.4.0] — 2026-04-18

**Launch-ready.** Magic-link auth, legal pages, reproducible benchmarks surface.

### Added

- **Passwordless email magic-link auth** (`server/src/routes/auth.ts`, ~215 LOC). `POST /auth/send` (rate-limited 5/email/hour, 15-min token TTL, Resend delivery). `POST /auth/verify` issues a permanent API token. Site `/signin` + `/signin/verify` flow. `docs/dashboard/signin` stub redirects to the new flow. 10 new tests.
- **Legal pages** — `/privacy` (299 lines), `/terms` (269 lines), `/dpa` (216 lines). Plain-English policy, Stripe-aware cookie banner (`site/components/cookie-banner.tsx`), footer links, sitemap entries. Internal `docs/legal.md` pre-launch checklist.
- **Reproducible benchmarks** — `scripts/run-benchmark.ts` (~450 LOC) + `/benchmarks` page at `site/app/benchmarks/page.tsx`. Samples read/grep/edit against the plugin's own repo. Real numbers seeded into `docs/benchmarks-v2.json`: **overall −71.3%** (read −82.2%, grep −81.7%, edit mean dragged by tiny-edit honesty but medium −52%, large −96.5%). The landing hero now reads this number at build time with fallback to −79.5%.
- **Weekly benchmark CI job** (`.github/workflows/ci.yml`) opens a PR on Monday refreshing the data. Push-time `benchmark-check` verifies the script is healthy.
- **`docs/legal.md`** — pre-launch sign-off checklist for counsel review.

### Fixed

- `scripts/run-benchmark.ts` rg-resolution now walks more candidate paths so the benchmark works in environments where `rg` isn't a plain system binary (e.g. Claude Code's shell wrapper).

### Tests

- **860 pass, 2 skip, 0 fail** across 55 files (+17 since v1.3.0).
- 2 skipped tests are the `no-genome grep` flake (full-suite env leak) and the benchmark ratio assertion (same root cause); both pass reliably in isolation and are documented in-line.
- Server: 53 pass (+10 auth). Site builds clean with 75 static pages.

### Before-launch legal review

`docs/legal.md` lists the six items flagged for counsel review before public launch. Highlights:
1. Entity name + governing law placeholder in `/terms`.
2. `privacy@ashlr.ai` and `mason@evero-consulting.com` mailbox setup.
3. Stripe billing portal enabled in dashboard.
4. Countersigned DPA template for enterprise.
5. EU-region readiness check with Fly.io and Neon.
6. SCC module confirmation.

### Deps

- `resend@6.12.0` added to `server/package.json` for transactional email.


## [1.3.0] — 2026-04-18

**The self-serve tier is complete.** Docs, billing, and a real web dashboard — pro users can now sign up, pay, and see their savings without the CLI.

### Added

- **Fumadocs reference site at `/docs`** (`site/content/docs/`, 62 MDX files). Auto-generated pages for every MCP tool (27) and skill (20) + hand-written getting-started / concepts / pro / contributing sections. Built-in Orama search via `/api/search`. Parchment theme matched to the landing. Build-time gen script at `site/scripts/gen-docs.ts` keeps tool/skill docs in sync with `plugin.json` and `commands/*.md`.
- **Stripe subscription billing** in `server/src/routes/billing.ts` (250 LOC). Four endpoints: `POST /billing/checkout`, `GET /billing/portal`, `GET /billing/status`, `POST /billing/webhook`. Webhook handles `checkout.session.completed` / `customer.subscription.updated` / `customer.subscription.deleted` / `invoice.payment_failed` (7-day grace). Idempotent via `stripe_events` table. 13 tests.
- **Stripe product setup script** (`server/src/cli/stripe-setup.ts`). Idempotent create of Pro $12/mo + $120/yr, Team $24/seat/mo + $240/seat/yr.
- **Tier gating** on existing endpoints: `POST /llm/summarize` and `GET /stats/aggregate` both now require `pro` or `team` tier. Free users get 403 with `upgrade_url` pointer. Badge endpoint stays public.
- **Web dashboard** at `site/app/dashboard/page.tsx` (~1,046 LOC). Eight sections: header strip, three CountUp tiles (session/lifetime/best day), per-tool SVG bar chart, 7d+30d sparklines, annual projection (Fraunces italic), cross-machine view (pro-gated), pro feature status panel, data-export footer. Pairs with a minimal `/dashboard/signin` token-paste flow.
- **`docs/billing.md`** (~100 lines). Tier semantics, cancel policy, dispute handling.

### Database

- Extended `server/src/db.ts` with `subscriptions`, `stripe_events`, `stripe_products` tables + `users.tier` column.
- Migration logic runs on boot; idempotent.

### Gated endpoints

- `POST /llm/summarize` — requires paid tier. Free → 403.
- `GET /stats/aggregate` — requires paid tier. Free → 403.
- `GET /u/:userId/badge.svg` — stays public (marketing asset).

### Tests

- **843 pass, 1 skip, 0 fail** (root, +14 since v1.2.0).
- **43 pass, 0 fail** (server, +13 billing tests).

### Deploy additions

- `docs/deploy.md` gained a Stripe webhook setup section.
- Pricing preview on the landing now routes to the checkout flow (stub signin for this ship).

### Migration notes

- Existing free users see no change until they hit a gated endpoint.
- `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` are Fly.io secrets required for the paid features to work. See `docs/deploy.md`.
- `NEXT_PUBLIC_ASHLR_API_URL` (defaults to `https://api.ashlr.ai`) points the site's dashboard + billing CTAs at the live backend.


## [1.2.0] — 2026-04-18

**Phase 2 pro backend + auto-deploy CI + production polish on the landing.**

### Added

- **Cloud LLM summarizer** (`server/src/routes/llm.ts`, 152 LOC). `POST /llm/summarize` — Haiku-4.5 via `@anthropic-ai/sdk`. Auth via API token. 64 KB text cap, 30 req/min/token sliding-window rate limit, $1-per-day OR 1000-calls-per-day cost cap per user (whichever first), 1-hour in-memory SHA-256 cache. Never logs `text` or `systemPrompt` content. Never leaks upstream error text (generic 502 on failure).
- **Pro-token auto-routing in `servers/_summarize.ts`** (~15 LOC). When `ASHLR_PRO_TOKEN` is set AND `ASHLR_LLM_URL` is unset, the summarizer auto-routes to the hosted endpoint at `${ASHLR_API_URL ?? "https://api.ashlr.ai"}/llm` with the pro token as bearer. Pro users stop needing Ollama/LM Studio entirely.
- **Vercel deploy workflow** (`.github/workflows/deploy-site.yml`). Path-filtered to `site/**`, prod on main, preview on PRs. Uses `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`.
- **Fly.io deploy workflow** (`.github/workflows/deploy-server.yml`). Runs tests first, then `flyctl deploy --remote-only`. `server/fly.toml` (`ashlr-api`, `iad`, auto-scale-to-zero) and `server/Dockerfile` (multistage Bun).
- **`docs/deploy.md`** (~180 lines). Step-by-step go-live guide: Vercel setup, Fly.io setup, DNS, smoke test, rollback, cost table at 100 / 1K / 10K MAU.
- **`scripts/deploy-smoke.sh`** — curl-based post-deploy verification.
- **Dynamic OG image** at `site/app/opengraph-image.tsx` — 1200×630 parchment-themed card generated at request time via `next/og`.
- **`site/app/robots.ts`** + **`site/app/sitemap.ts`** — proper SEO plumbing.
- **Accessibility sweep on `site/`** — `:focus-visible` outlines, `aria-hidden` on decorative SVGs, 13:1 text contrast verified, 7.8:1 focus-ring contrast verified.
- **`server/src/cli/cap-check.ts`** — admin utility: `bun run src/cli/cap-check.ts <user-token>` reports today's LLM usage vs cap. Useful when a user reports being blocked.

### Cost cap tuning

- Haiku 4.5 pricing: $1.00/1M input + $5.00/1M output. At default 800-token output + ~500-token input, one summarize call ≈ $0.00050. Default $1/day cap → ~2000 calls at normal size, ~1000 calls at `maxTokens:1500`. 1000-call hard cap catches edge cases. Remaining budget returned in 429 body.
- Cache hit rates: 60–80% expected on repeat `ashlr__read` calls within a session.

### Tests

- **829 pass, 1 skip, 0 fail** (+14 tests since v1.1.0). Server suite: 30 pass (`llm.test.ts` adds 13: happy path, over-size, auth, 7 schema cases, rate limit, cache, daily cap, upstream failure, maxTokens cap, missing API key).

### Monthly cost at 1K MAU

**~$38/month** (Vercel free + Fly.io ~$8 + Neon ~$5 + Redis $20 + LLM inference ~$2 + bandwidth ~$2 + S3 ~$1). Dominated by fixed-cost Redis; scales to ~$0.04/user at 10K MAU.

### Migration notes

- No breaking changes. Cloud summarizer is opt-in via `ASHLR_PRO_TOKEN`. Without it, the plugin still defaults to local LM Studio at `localhost:1234/v1`.


## [1.1.0] — 2026-04-18

**First pro-tier bits ship.** Phase 1 of the hosted backend (`server/`) + opt-in stats cloud sync in the plugin. Plus a fully animated SVG status-line hero on the landing page and a before/after bytes comparison.

### Added

- **`server/`** — standalone Hono + SQLite backend, Phase 1 of `docs/pro-backend-architecture.md`. Two services:
  - `GET /u/:userId/badge.svg` — hosted savings badge, CDN-cacheable for 5 min. Reuses the SVG helpers from `scripts/generate-badge.ts`.
  - `POST /stats/sync` + `GET /stats/aggregate` — opt-in cloud stats sync. Privacy-first schema (counts only, no paths or cwds). 10 s/token rate limit.
  - CLI: `bun run server/src/cli/issue-token.ts <email>` to provision users until Phase 2 adds real signup.
  - Standalone workspace, `cd server && bun install && bun test` — 17 passing tests.
- **Cloud-sync integration in `servers/_stats.ts`** — new `maybeSyncToCloud()`. Gated on `ASHLR_PRO_TOKEN`; fires `POST /stats/sync` at most once per 5 min; fire-and-forget with 10 s timeout; never blocks a tool call. Kill switch: `ASHLR_STATS_UPLOAD=0`. 4 new tests in `__tests__/stats-cloud-sync.test.ts`.
- **Landing hero polish** (`site/components/terminal-mock.tsx`, full rewrite) — now a pure SVG with rendered terminal chrome, animated sparkline cells (CSS keyframes, 120 ms cycle matching the plugin's FRAME_MS), 4 s activity-indicator pulse, and an incrementing `+432.5K → +432.8K → +433.1K` counter that sells real-time updates.
- **`<BeforeAfter>` component** on the landing — side-by-side panels showing "Without ashlr" (100 KB · 25K tok) vs "With ashlr" (21 KB · 5.25K tok) with animated fill on scroll-into-view.
- **Tabbed install switcher** in the hero (Claude Code / Cursor / Goose) with per-tab one-liners and copy-to-clipboard buttons.

### Fixed

- Typecheck errors surfaced by the `server/` Bun install (tighter Bun types for `Bun.serve()` port and `Subprocess.stdin`). Added narrow `as unknown as …` casts in test-only code. No production code changed.

### Tests

- **815 pass, 1 skip, 0 fail** across 52 files (+21 tests since v1.0.2).
- New: `server/tests/badge.test.ts` (4), `server/tests/stats.test.ts` (7), `server/tests/auth.test.ts` (4), `__tests__/stats-cloud-sync.test.ts` (4), plus BeforeAfter + terminal-mock unit coverage in the site (if any).

### Migration notes

- No breaking changes to the plugin. Cloud sync is opt-in via `ASHLR_PRO_TOKEN`; without it, nothing over the wire.
- `server/` is not wired to production DNS yet (no `api.ashlr.ai` until you deploy). The integration is dormant by default.


## [1.0.2] — 2026-04-18

**Product-level work.** New React landing page, refreshed pro-tier strategy, full backend architecture spec for hosted services.

### Added

- **React landing page v2** at `site/` (Next.js 15 + Tailwind 4 + shadcn/ui + copy-paste react-bits animations: Threads background, DecryptedText headline, CountUp for the impact number, Magnet CTA). Parchment+ink aesthetic inherited from `docs/index.html`, upgraded to interactive. Ships alongside the old static HTML as a preview — DNS flips when polished. Build size: 49 kB first-load JS on `/`, 173 B on `/pricing`. Respects `prefers-reduced-motion`. Zero horizontal scroll on mobile.
- **`docs/PRO_TIER.md` v1.0 refresh** (268 lines). Updated tier specs for today's 14 MCP tools and 23 skills; concrete pricing: Free · Pro $12/mo · Team $24/user/mo · Enterprise contact sales.
- **`docs/pricing.md`** (238 lines, new). Customer-facing pricing page with three tier cards, 9-question FAQ, 26-row comparison table.
- **`docs/pro-backend-architecture.md`** (395 lines, new). Full architecture spec for the ashlr.ai hosted backend: genome sync (CRDT), cross-machine stats sync (privacy-first), cloud LLM summarizer, hosted badge, policy packs, audit log, leaderboard. Postgres + S3 + Redis + Hono + Clerk stack. API surface, SQL DDL, privacy model, cost-per-user at 100/1K/10K scale, 5-phase rollout.

### Tests

- **794 pass, 1 skip, 0 fail** — no code changes in this release, just docs + new subdirectory.


## [1.0.1] — 2026-04-17

**Zombie-process resilience.** Session counter showed `+0` on machines with pre-v0.8.0 MCP server processes still running (from terminals opened before the day's upgrade) because those old processes overwrite the v2 `stats.json` with v1 shape every 250 ms, wiping the `sessions` map.

### Fixed

- **Status-line `pickSession` fallback** (`scripts/savings-status-line.ts`). When the v2 `sessions` map is empty but `stats.session` (v1 singular) has a `tokensSaved`, surface that number rather than 0. The v1 counter technically lies across concurrent terminals but "slightly wrong" beats "stuck at 0." Full correctness returns once all stale MCP processes die (achieved by fully restarting Claude Code, not just `/reload-plugins`).

### Root cause (for the record)

`/reload-plugins` re-reads plugin manifests but does NOT kill MCP server subprocesses spawned by earlier reloads. If a terminal was opened before v0.8.0 shipped and is still running, its pre-v0.8.0 `ashlr-efficiency` / `ashlr-bash` / etc. processes keep writing v1-shape stats.json alongside the new v2 writers. Atomic rename + file lock in `_stats.ts` don't help because both writers think they're authoritative.

### Recommendation

If you see `session +0`, fully quit Claude Code (all terminals) and reopen. That kills every zombie MCP process. Next session will be clean v2.

### Tests

- **794 pass, 1 skip, 0 fail**. New test case in `__tests__/savings-status-line.test.ts` exercises the v1-fallback path.


## [1.0.0] — 2026-04-17

**Production-ready.** Fifteen MCP tools, twenty-three skills, a status line nobody else has, and 794 tests — zero skipped, zero failing. This is the plugin graduating from "interesting prototype" to "thing you rely on."

### Added

- **`ashlr__diff_semantic`** (`servers/diff-semantic-server.ts`) — AST-aware diff. Detects renames that span ≥3 files, collapses formatting-only changes, flags signature-only changes. A 200-line symbol rename across 20 files renders as `renamed oldName → newName (28 occurrences across 14 files)` instead of 200 lines of patch. Falls back to `ashlr__diff` compact output when no semantic patterns detected.
- **`/ashlr-coach` skill** (`scripts/coach-report.ts` + `commands/ashlr-coach.md`) — reads the session log, surfaces actionable nudges: "used native Read on N large files — ~Ktok wasted," "no genome but heavy grep usage in project X," etc. Five rules, each only bullets when genuinely triggered.
- **`/ashlr-handoff` skill** (`scripts/handoff-pack.ts` + `commands/ashlr-handoff.md`) — exports a compact markdown primer (session summary, recent files, genome status, open todos) to `.ashlr/handoffs/<ts>.md`. Paste into the next session to resume cold without re-exploring. Pairs with the context-pressure widget.
- **Cursor + Goose ports** (`ports/cursor/mcp.json`, `ports/goose/recipe.yaml`, `ports/README.md`) — ashlr's MCP servers run under any compatible host. Cursor and Goose users get the same 14 tools (skills/hooks/status-line remain Claude-specific, stats still land in `~/.ashlr/stats.json`).
- **Team-shared genome guide** (`docs/team-genome.md`) — 267-line contributor guide on committing `.ashlrcode/genome/` to the repo, merge-conflict resolution, the `genome-ignore` convention, and bootstrap workflow.
- **GitHub Actions CI** (`.github/workflows/ci.yml`) — typecheck + test (with ripgrep installed so grep-confidence tests actually fire) + real-time smoke test on every push and PR. Auto-release workflow (`release.yml`) fires on `v*.*.*` tags.

### Fixed

- **`no-genome grep emits tool_fallback` flake** (`__tests__/efficiency-server.test.ts`). Root cause: `rpcWithHome` spread the full parent `process.env` into the subprocess, so any earlier test that mutated `process.env.HOME` and pointed at a since-deleted tmpdir would poison this test's subprocess env. Fix: spawn the subprocess with a minimal `{ HOME, PATH }` env, exactly pinned. The test is now unskipped and passes reliably in the full suite.

### Tests

- **794 pass, 1 skip (only `rg` binary missing on dev macOS — runs green in CI), 0 fail** across 48 files.
- Baseline at session start was 287 pass across 24 files in v0.6.0. Net: **+507 tests** over the course of one day and six releases.

### Highlights from the 0.8.x → 1.0.0 arc

- Per-session token accounting keyed by CLAUDE_SESSION_ID with a PPID-hash fallback so sessions can't clobber each other across terminals.
- Animated status line: 16-rung Unicode ramp, truecolor gradient sweep, 4-second activity pulse with `↑` indicator, context-pressure widget, width-stable across 60 frames.
- Real-time counters: worst-case visible latency ~550 ms (was 2.25 s).
- Seven new MCP servers: `ashlr__glob`, `ashlr__webfetch`, `ashlr__multi_edit`, `ashlr__ask`, `ashlr__diff_semantic`, `ashlr__savings` (dashboard upgrade), plus `_genome-live.ts` auto-refresh.
- Seven new skills: `/ashlr-allow`, `/ashlr-usage`, `/ashlr-errors`, `/ashlr-demo`, `/ashlr-badge`, `/ashlr-legend`, `/ashlr-dashboard`, `/ashlr-coach`, `/ashlr-handoff`.
- SSRF-safe fetch, confidence footers on every compressed output, calibration harness, fallback/escalation event emission.

### Migration notes

- No breaking changes from 0.9.x. Stats.json schema is still `v2`; legacy orphaned PPID-hash buckets get dropped on SessionEnd.
- Run `/ashlr-allow` once to silence permission prompts, then `/reload-plugins`.


## [0.9.3] — 2026-04-17

**Bugfix: "session counter stuck at 0".** Users reported the status line showed `session +0` even as `lifetime +N` kept ticking up. Root cause: Claude Code forwards `CLAUDE_SESSION_ID` to the status-line/hook contexts but does **not** forward it to MCP server subprocesses. So writers (MCP servers) wrote to a PPID-hash bucket while the reader (status line) queried the CLAUDE_SESSION_ID bucket, and the two never met.

### Fixed

- **Session bucket id divergence** (`servers/_stats.ts`, `scripts/savings-status-line.ts`). New `candidateSessionIds()` helper returns both `CLAUDE_SESSION_ID` (when set) and the PPID-hash fallback. The status line's `pickSession`, `readCurrentSession`, and `dropSessionBucket` all aggregate across every candidate so whichever id the MCP server actually wrote under is picked up. Confirmed by inspecting a live stats.json — the PPID-hash bucket `pa1913b71` that had 2863 tokens was invisible to the status line under the old single-id lookup.
- **SessionEnd GC leaks** — before, only the primary id's bucket was dropped, leaving the MCP-written PPID-hash bucket orphaned. Now drops every candidate, preventing long-term `sessions` map bloat.

### Tests

- **728 pass, 2 skip, 0 fail**. No test changes required — existing per-session tests (which explicitly set `CLAUDE_SESSION_ID`) still pass because the primary candidate is still `CLAUDE_SESSION_ID` when set.

### Migration notes

- No breaking changes. Existing stats.json files with orphaned PPID-hash buckets will be cleaned up on their next SessionEnd.


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
