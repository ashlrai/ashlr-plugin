# ashlr-plugin Architecture

Reference for contributors. Covers system shape, data flows, and conventions. All file references are relative to the plugin root unless otherwise noted.

> **Platform support:** ashlr-plugin runs on Windows, macOS, and Linux. All Claude Code hooks are TypeScript files invoked via `bun run`. There are no bash-only code paths in the hot loop. The legacy `.sh` files in `hooks/` remain for reference but `hooks/hooks.json` points exclusively at the `.ts` siblings. See [install-windows.md](install-windows.md) for Windows-specific notes.

---

## 1. Overview

ashlr-plugin is a Claude Code plugin that wraps the native file, search, and edit tools with lower-token alternatives and adds a lightweight observability layer over tool usage and cost.

Two value propositions:

**Token efficiency.** `ashlr__read`, `ashlr__grep`, and `ashlr__edit` replace the built-in `Read`, `Grep`, and `Edit` tools. Large file reads are snip-compacted or LLM-summarized; grep calls route through a per-project genome index (RAG) when one exists, cutting tokens by ~84% on warm queries; edits send only diffs, not full file contents.

**Observability.** Every tool call is accounted in `~/.ashlr/stats.json` (per-session + lifetime counters) and appended to `~/.ashlr/session-log.jsonl`. The status line in Claude Code's UI surfaces savings continuously. The genome scribe loop extracts architectural knowledge from tool results into `.ashlrcode/genome/`, which feeds back into future grep routing.

The canonical wiring entry point is `.claude-plugin/plugin.json`. Every MCP server, hook, and status line command is registered there.

---

## 2. MCP Server Map

Source of truth: `.claude-plugin/plugin.json:mcpServers`. As of v1.13, **a single `ashlr` router entry** replaces the previous 16 per-server entries. The router at `servers/_router.ts` dispatches all 33 tools (29 core + 4 GitHub write ops added in v1.18) via a shared `registerTool` / `getTool` registry. `plugin.json` has one `mcpServers` entry:

```json
"ashlr": {
  "command": "bun",
  "args": ["run", "${CLAUDE_PLUGIN_ROOT}/scripts/mcp-entrypoint.ts", "servers/_router.ts"]
}
```

The bun-native entrypoint (`scripts/mcp-entrypoint.ts`) replaces the legacy bash wrapper so the plugin runs on Windows without Git Bash. It handles first-run `bun install`, stale-sibling version cache cleanup, and `CLAUDE_SESSION_ID` forwarding. The legacy `scripts/mcp-entrypoint.ts` is retained for the `ports/` distributions (Cursor, Goose) that run in Unix-only environments.

`ASHLR_ROUTER_DISABLE=1` is retained as a kill switch for one release cycle (reverts to legacy per-server mode).

### Tool registry (all 33 tools)

| Tool | Origin server module | Replaces (native) |
|---|---|---|
| `ashlr__read` | `servers/efficiency-server.ts` | `Read` |
| `ashlr__grep` | `servers/efficiency-server.ts` | `Grep` |
| `ashlr__edit` | `servers/efficiency-server.ts` | `Edit` (baseline is `search+replace` bytes as of v1.18 Trust Pass) |
| `ashlr__edit_structural` | `servers/edit-structural-server.ts` | — (v2 as of v1.18: Unicode identifiers, cross-file rename with `anchorFile`/`maxFiles`/shadowing guard/dryRun, extract-function with return-value detection) |
| `ashlr__multi_edit` | `servers/multi-edit-server.ts` | — |
| `ashlr__savings` | `servers/efficiency-server.ts` | — |
| `ashlr__flush` | `servers/efficiency-server.ts` | — |
| `ashlr__bash` | `servers/bash-server.ts` | `Bash` (v1.18: process-group SIGKILL on timeout, pluggable summarizer registry) |
| `ashlr__bash_start` / `_stop` / `_tail` / `_list` | `servers/bash-server.ts` | — (long-running control plane) |
| `ashlr__diff` | `servers/diff-server.ts` | — |
| `ashlr__diff_semantic` | `servers/diff-semantic-server.ts` | — |
| `ashlr__sql` | `servers/sql-server.ts` | — |
| `ashlr__tree` | `servers/tree-server.ts` | — |
| `ashlr__http` | `servers/http-server.ts` | `WebFetch` |
| `ashlr__logs` | `servers/logs-server.ts` | — |
| `ashlr__genome_propose` / `_consolidate` / `_status` | `servers/genome-server.ts` | — |
| `ashlr__orient` | `servers/orient-server.ts` | — |
| `ashlr__issue` / `ashlr__pr` | `servers/github-server.ts` | — (wraps `gh` CLI) |
| `ashlr__pr_comment` / `ashlr__pr_approve` | `servers/github-server.ts` | — (v1.18 PR write ops; `pr:"current"` via `gh pr view`, self-approval guard, `ASHLR_REQUIRE_GH_CONFIRM=1`) |
| `ashlr__issue_create` / `ashlr__issue_close` | `servers/github-server.ts` | — (v1.18 issue write ops; no destructive ops) |
| `ashlr__glob` | `servers/glob-server.ts` | `Glob` |
| `ashlr__ls` | `servers/ls-server.ts` | — |
| `ashlr__webfetch` | `servers/webfetch-server.ts` | `WebFetch` (summarizes at 4 KB as of v1.18) |
| `ashlr__ask` | `servers/ask-server.ts` | — |
| `ashlr__test` | `servers/test-server.ts` | — (bun/vitest/jest/pytest/go test parser; v1.18: async spawn + `bun.lock` text detection) |

The router pattern: each server module calls `registerTool(name, handler)` at import time. The router's `CallToolRequestSchema` handler calls `getTool(name)(params)` — no per-server process spawning, one stdin/stdout pair.

### Shared infrastructure modules

- **`servers/_pricing.ts`** (v1.18) — single source of truth for $/MTok across the plugin. Consumed by `efficiency-server.ts`, `scripts/savings-dashboard.ts`, `scripts/savings-status-line.ts`, and `session-greet.ts`. Prior to v1.18 each surface hardcoded its own rate, producing three different dollar values for the same token count. `ASHLR_PRICING_MODEL` env var selects the model (default `sonnet-4.5` at $3/MTok input; `opus-4`, `haiku-4.5` also supported).
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

Two serialization layers — the in-process mutex (a chained Promise) prevents concurrent async calls within one server process from racing; the filesystem lock extends that to the 12 servers and hooks that can run simultaneously. The rename is atomic at the OS level, so readers never see a partial write.

### schemaVersion and migration

`stats.json` carries `"schemaVersion": 2`. On load, `_stats.ts:readStats` checks the version and migrates forward if needed (v1 had a single global `session` field; v2 moves that to the per-session map). The migration is additive and non-destructive — old lifetime counters are preserved.

---

## 4. Hook Graph

Hooks are declared in `hooks/hooks.json` and executed by the Claude Code harness. The file references below show where each hook lives.

```
Session opens
    │
    ▼
SessionStart ──► hooks/session-start.ts
    │              • Runs baseline scanner (project orientation)
    │              • Calls initSessionBucket() in _stats.ts
    │              • Emits session greeting to stderr
    │
    ▼  (for each tool call)
PreToolUse  (matcher: "Read")  ──► hooks/pretooluse-read.ts
PreToolUse  (matcher: "Grep")  ──► hooks/pretooluse-grep.ts
PreToolUse  (matcher: "Edit")  ──► hooks/pretooluse-edit.ts
    │   (as of v1.18: emits permissionDecision: "deny" with actionable
    │    "call mcp__plugin_ashlr_ashlr__ashlr__* instead" message when
    │    ASHLR_HOOK_MODE=redirect, which is the default. Safety nets:
    │    paths outside cwd (realpath-canonicalized for macOS /tmp →
    │    /private/tmp), paths inside CLAUDE_PLUGIN_ROOT, bypassSummary:true
    │    are never redirected. Escape hatch: ASHLR_HOOK_MODE=nudge or
    │    hookMode:"nudge" in ~/.ashlr/config.json.)
    ▼
  [ tool executes ]
    │
    ▼
PostToolUse (matcher: Write|Edit|MultiEdit|Bash|mcp__plugin_ashlr_ashlr__ashlr__*)
    ├──► hooks/genome-scribe-hook.ts      (genome auto-propose; matcher expanded
    │                                      in v1.18 to cover MultiEdit,
    │                                      ashlr__multi_edit, ashlr__edit_structural)
    └──► hooks/session-log-append.ts      (JSONL append)
    │
    ▼
SessionEnd
    ├──► hooks/session-end-consolidate.ts  (genome consolidation; v1.17+ fires
    │                                       scripts/genome-cloud-push.ts afterwards
    │                                       when .cloud-id present)
    └──► hooks/session-end-stats-gc.ts     (drop session bucket, append summary to log)
```

PreToolUse hooks are matcher-filtered — Claude Code only fires them for the named tool. PostToolUse has a pipe-separated matcher covering both native tools and the ashlr MCP variants (canonical prefix `mcp__plugin_ashlr_ashlr__ashlr__*` as of v1.13 router consolidation; all matchers in `hooks/hooks.json` renamed to this form in v1.18 after legacy `mcp__ashlr-efficiency__*` / `mcp__ashlr-multi-edit__*` stopped matching post-router-migration).

---

## 5. Genome Lifecycle

The genome is a per-project knowledge base stored under `.ashlrcode/genome/`. It powers genome-aware `ashlr__grep` routing and surfaces architectural context during sessions.

**Init** — `scripts/genome-init.ts` (invoked by the `/ashlr-genome-init` skill). Creates the scaffold via `@ashlr/core-efficiency/genome:initGenome`, then writes three knowledge files: `knowledge/architecture.md` (baseline scanner output), `knowledge/conventions.md` (detected from config files), and `knowledge/decisions.md` (ADR-0000 placeholder).

**Propose (edit-triggered)** — `hooks/post-tool-use-genome.sh` fires on every Write/Edit/MultiEdit/Bash call. It pipes the PostToolUse payload to `scripts/genome-auto-propose.ts`, which:
1. Skips trivial tools via a whitelist.
2. Regex-matches architecture/decision signals in the result text.
3. Deduplicates by SHA-256 of the first 500 chars against a persisted set at `~/.ashlr/genome-proposals-seen.json` (capped at 10K entries).
4. Walks up from `cwd` to find `.ashlrcode/genome/`.
5. Appends a JSONL record to `proposals.jsonl` with the current generation number.

**Consolidate (session-end or threshold)** — `hooks/session-end-consolidate.sh` runs at SessionEnd. It also fires mid-session when the proposal count crosses a threshold. Consolidation calls `ashlr__genome_consolidate` (via `servers/genome-server.ts`), which delegates to `@ashlr/core-efficiency/scribe.ts` to merge pending proposals into the genome files. If a local LLM is reachable it summarizes the diffs; otherwise it does a line-level merge. Progress is logged to `~/.ashlr/genome-consolidation.log`.

---

## 6. Status Line Rendering

Claude Code calls the `statusLine.command` from `plugin.json` periodically and renders the first stdout line in its UI bar.

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

**Append path** — `hooks/session-log-append.sh` fires PostToolUse. It uses `bun` to parse the hook payload and emit a structured record; falls back to a minimal bash-built record if bun is unavailable. Self-rotates at 10 MB to `session-log.jsonl.1`.

**Record schema:**
```json
{ "ts": "ISO-8601", "agent": "claude-code", "event": "tool_call",
  "tool": "ashlr__read", "cwd": "/abs/path", "session": "sess-id",
  "input_size": 42, "output_size": 310 }
```

**Session-end summary** — `hooks/session-end-stats-gc.ts` appends one final record per session with `event: "session_end"` carrying `calls`, `tokens_saved`, and `started_at` from the bucket being dropped.

**Planned events** — `tool_fallback` (LLM summarization fell back to snip-compact) and `tool_escalate` (agent escalated from haiku to sonnet) are reserved event types.

**Aggregator** — `scripts/session-log-report.ts` reads the log (+ rotated `.1`) and produces a plain-text report covering top tools by call count, per-project breakdowns, 24h vs lifetime comparison, and recent session summaries. Exposed via the `/ashlr-usage` skill.

---

## 8. Summarization

Source: `servers/_summarize.ts`.

**When it fires.** Each tool that handles large output (read, grep, edit, bash, sql, diff) checks if the raw result exceeds ~2KB. If so it calls `summarize(content, toolName)`.

**Local-first.** Default endpoint is `http://localhost:1234/v1` (LM Studio). Override via `ASHLR_LLM_URL` + `ASHLR_LLM_KEY` for cloud. Cloud only fires when explicitly set — the plugin has no account requirement and no telemetry.

**Cache.** SHA-256 of the input is used as cache key. Cache files live at `~/.ashlr/summary-cache/<hash>.txt` with a 1-hour TTL. A cache hit costs zero tokens.

**Fallback.** If the LLM endpoint is unreachable or times out (5s), `summarize` falls back to snipCompact truncation and appends `[LLM unreachable, fell back to truncation]` so the agent can see what happened. `bypassSummary: true` on any tool call skips LLM and snip-compacts directly.

**Per-tool prompts.** `_summarize.ts:TOOL_PROMPTS` maps tool names to system prompts tuned for each output type: file contents preserve imports and signatures; bash preserves errors and final result lines; SQL preserves first/last rows and counts. Reading from the end of the file gives the full prompt set.

---

## 9. Adding a New MCP Tool

With the consolidated router, adding a tool no longer requires a new `mcpServers` entry in `plugin.json`.

1. **Create or extend a server module** (e.g. `servers/foo-server.ts`):
   - Import `registerTool` from `servers/_router.ts`.
   - Call `registerTool("ashlr__foo", async (params) => { ... })` at module top level.
   - Call `await recordSaving(tokensEstimate, costEstimate, "ashlr__foo", cwd)` after each successful call.
   - Wrap handler body in `try/catch`; return `{ content: [...], isError: true }` on error.

2. **Import the module in `servers/_router.ts`** so `registerTool` runs at startup.

3. **Write tests in `__tests__/foo-server.test.ts`**. Use `mkdtemp` for an isolated `HOME` so no test touches `~/.ashlr`. Spawn the real server process and speak JSON-RPC over stdio (see `__tests__/efficiency-server.test.ts` for the `rpc()` helper pattern).

4. **Add to `CHANGELOG.md`** under the current version block.

5. **Update this document** — add a row to the tool registry table in section 2.

No `plugin.json` change is needed. The entrypoint script handles `bun install` automatically.

---

## 10. Testing Model

Test runner: `bun test`. All test files live in `__tests__/`.

**Isolation.** Every test suite that touches the filesystem creates a `mkdtemp` temp dir and passes it as `HOME` (or equivalent) to the code under test. No test reads or writes the real `~/.ashlr`. See `__tests__/session-log-report.test.ts:beforeEach` for the canonical pattern.

**Integration tests.** `__tests__/efficiency-server.test.ts` spawns the real MCP server process and sends JSON-RPC requests over stdio. This catches wiring bugs that unit tests miss. The `rpc(reqs, env)` helper in that file is reusable for other server tests.

**Fixture conventions.** Synthetic log/stats data is built inline as arrays of typed records, not from files on disk. This keeps tests hermetic and readable without fixture file management.

**Special test groups:**
- `__tests__/integration/` — multi-server or end-to-end scenarios.
- `__tests__/quality/` — snapshot/regression tests for rendered output (savings report, status line).

**Running:**
```
bun test                      # all tests
bun test __tests__/foo.test.ts  # single file
```

Tests that require a live database are skipped automatically when `$TEST_DATABASE_URL` is absent.

---

## 11. Release Flow

Script: `scripts/publish.sh`. Accepts `--dry-run`.

Steps:
1. Checks `gh auth status`.
2. Creates the `ashlr-plugin` GitHub repo (public) if it doesn't exist, then pushes `main`.
3. Optionally creates and pushes `@ashlr/core-efficiency` if the sibling repo exists locally.
4. Enables GitHub Pages from `/docs` (POST then PUT — idempotent).

Version bumping is manual: edit `plugin.json:version` and `CHANGELOG.md` before running the script. There is no automated semver bump. The `scripts/mcp-entrypoint.ts` reads the version from `plugin.json` to identify stale sibling cache dirs and clean them up.

---

## 12. Design Principles

These are the non-obvious decisions baked into the codebase.

**Local-first LLM, no telemetry.** The summarization helper calls `localhost:1234` by default. No data leaves the machine unless the user explicitly sets `ASHLR_LLM_URL`. There is no analytics, no error reporting endpoint, no call home.

**Atomic stats writes.** A two-layer write protocol (in-process Promise chain + `O_EXCL` lockfile + `rename`) ensures that N concurrent MCP servers and hooks never corrupt `stats.json`. Any approach that just does `JSON.parse` → mutate → `writeFile` will lose updates under load. The lockfile spin is capped at 200ms; if it can't acquire, it skips the write rather than blocking the tool call.

**Per-session accounting.** The old `stats.json` had a single global `session` field. With multiple Claude Code terminals open, every server clobbered each other's counter. v2 uses `CLAUDE_SESSION_ID` as a bucket key. The `mcp-entrypoint.sh` explicitly forwards this env var into every server subprocess.

**Width-stable status line.** The status line must not reflow the UI on every refresh. `visibleWidth()` strips ANSI escapes before measuring. Segments are truncated (not wrapped) to stay within 80 chars. The sparkline always occupies the same number of columns regardless of savings magnitude.

**Genome is fire-and-forget.** The auto-propose hook, the consolidation hook, and the genome server are all written to never throw and never block the agent. A genome write failure is invisible to the user. This is intentional — genome is an optimization layer, not a correctness requirement.

**GC at session end.** Per-session buckets are dropped from `stats.json` when the session closes (`hooks/session-end-stats-gc.ts`). Lifetime counters are never dropped. This bounds `stats.json` size without losing the numbers that matter.

---

## Supported Platforms

ashlr-plugin is tested in CI on three operating systems via a matrix strategy in `.github/workflows/ci.yml`. The `typecheck`, `test`, and `smoke` jobs all run on every OS on every push.

| Platform | Runner | Status |
|---|---|---|
| Linux | `ubuntu-latest` (Ubuntu 22.04) | Full support |
| macOS | `macos-latest` (macOS 14 Sonoma) | Full support |
| Windows | `windows-latest` (Windows Server 2022) | Full support — see caveats below |

### Caveats

**ripgrep install.** The install step is platform-specific: `apt-get` on Linux, `brew` on macOS, `winget` (falling back to `choco`) on Windows. The plugin itself does not bundle ripgrep; it must be on `PATH`.

**File permissions.** Three tests are skipped on Windows with `test.skipIf(process.platform === "win32")` because Windows does not honour POSIX `chmod` mode bits:
- `genome-crypto.test.ts` — key file mode 0600 check
- `genome-init.test.ts` — unreadable dir (chmod 000) fallback
- `doctor.test.ts` — non-executable hook warnings / chmod +x fix

**bash-server.** The `ashlr-bash` MCP server spawns `sh -c` commands. On Windows this requires Git Bash or WSL in the user's `PATH`. The server tests are Linux/macOS only in practice; Windows users who need `ashlr__bash` should install Git for Windows. On POSIX, v1.18 spawns with `detached: true` and kills the process group (`-pid`) on timeout so forked grandchildren (`npm install`, `cargo build`) don't leak past the timeout. Policy-enforce cache path uses `os.tmpdir()` (v1.18) so the hook works on Windows.

**CRLF line endings.** The checkout step sets `core.autocrlf false` in all matrix jobs to prevent git from converting LF to CRLF on Windows, which would break hash-based cache keys and diff expectations.

**Integration tests.** The `integration` job runs on Linux only. These tests spawn the backend server process; the server is deployed on Linux in production, so Linux e2e parity is sufficient. See `docs/platform-support.md` for the full matrix of what runs where.
