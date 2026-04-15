# Changelog

All notable changes to ashlr-plugin. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] — 2026-04-15

**WOZCODE feature-parity release.** Four new hooks + status line + three new slash commands + critical `.mcp.json` fix. 57/57 tests pass.

### Added

- **Tool-redirect hook** (`hooks/tool-redirect.ts`) — `PreToolUse` on `Read|Grep|Edit`. When the built-in tool is invoked, the hook emits `permissionDecision: "ask"` with `additionalContext` naming the `ashlr__*` equivalent and its arguments. Result: savings become automatic rather than depending on the agent remembering to choose the ashlr tools. Opt out via `ashlr.toolRedirect: false`.
- **Commit attribution hook** (`hooks/commit-attribution.ts`) — `PreToolUse` on `Bash`. Rewrites `git commit -m "..."` (also single-quoted and `--message=` forms) to append `Assisted-By: ashlr-plugin`. Skips cleanly when a trailer is already present. Pass-through on bare commits, `-F file`, and `-am` (documented in tests). Opt out via `ashlr.attribution: false`.
- **Edit-batching nudge** (`hooks/edit-batching-nudge.ts`) — `PostToolUse` on `Edit` / `ashlr__edit`. After 4 edits in a 60-second rolling window, emits `additionalContext` suggesting the agent batch them. State keyed on PID so it resets per session.
- **Status-line integration** (`scripts/savings-status-line.ts`) — one-line output for Claude Code's status bar: `ashlr · session +12.3K · lifetime +1.2M · tip: use /ashlr-savings`. All four segments toggleable (`statusLine`, `statusLineSession`, `statusLineLifetime`, `statusLineTips`). Self-trims to 80 chars with `…`.
- **Status-line installer** (`scripts/install-status-line.ts`) — idempotent. Backs up `settings.json` before any write; refuses to clobber a foreign `statusLine.command`; seeds missing `ashlr.*` toggles without overwriting user values.
- **New slash commands**:
  - `/ashlr-recall` — read saved user preferences from `~/.ashlr/recall.json`; agent writes to it on "remember X" style prompts.
  - `/ashlr-update` — `git pull --ff-only && bun install` in the plugin dir, report commits pulled.
  - `/ashlr-benchmark` — run `servers/bench.ts --dir <current-project>/src` and report savings.
- **`hooks/hooks.json`** — wires all hooks to events.

### Fixed

- **`.mcp.json` variable** — was `${workspaceFolder}` (a VS Code variable). Is now `${CLAUDE_PLUGIN_ROOT}` (the Claude Code plugin convention). Without this, the MCP server wouldn't launch after install. Verified against WOZCODE's `.mcp.json`.

### Changed

- **`ashlr__edit` now applies the edit in place** (was: diff summary only). Strict-by-default (requires exactly one search match); pass `strict:false` to replace all occurrences. Clear errors on not-found / ambiguous matches.
- `rg` binary resolution in `ashlr__grep` now uses `Bun.which` + common Homebrew paths so shell aliases don't shadow the binary.

### Feature parity vs WOZCODE

Now at ~90% surface parity:
- ✅ Tri-agent (code/explore/plan)
- ✅ Optimized Read/Grep/Edit via MCP
- ✅ Tool-redirect hook (the key lever)
- ✅ Commit attribution hook
- ✅ Edit-batching nudge
- ✅ Status-line integration
- ✅ Savings tracker + `/savings` command
- ✅ Settings via `/ashlr-settings`
- ✅ `/recall`, `/update`, `/benchmark`
- ❌ SQL/database-specific tool (their claimed 10× DB-task speedup) — intentional non-goal for v0.2
- ❌ Own Bash tool — intentional non-goal
- ❌ Baseline scanner — intentional non-goal

Ethical differences preserved:
- ✅ Open source (MIT, every line auditable)
- ✅ No account, no login
- ✅ Zero telemetry (WOZCODE ships a PostHog project token in `.mcp.json`)
- ✅ Shared efficiency library consumable by the standalone CLI

### Tests

- 57 tests pass (up from 11 in v0.1.0):
  - 12 · tool-redirect
  - 14 · commit-attribution
  - 13 · savings-status-line
  - 7 · edit-batching-nudge
  - 11 · MCP server end-to-end

## [0.1.0] — 2026-04-15

Initial public release.

### Added
- MCP server with four tools: `ashlr__read`, `ashlr__grep`, `ashlr__edit`, `ashlr__savings`
- Three agents: `ashlr:code`, `ashlr:explore`, `ashlr:plan`
- Slash commands: `/ashlr-status`, `/ashlr-savings`, `/ashlr-settings`
- Session-start hook
- Benchmark harness (`servers/bench.ts`)
- Landing page at `plugin.ashlr.ai`
- CI pipeline (typecheck + MCP smoke + Pages deploy)
- Publish script (`scripts/publish.sh`)

### Design
- Efficiency primitives in a separate `@ashlr/core-efficiency` package, shared with the `ashlrcode` CLI
- MIT licensed, no account, no telemetry
