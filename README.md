# ashlr-plugin

**Same agent. Fewer tokens.**

<!-- fresh:begin version-badge -->
[![Version](https://img.shields.io/badge/version-1.37.1-blue)](https://www.npmjs.com/package/ashlr-plugin/v/1.37.1)
<!-- fresh:end -->
[![CI (Linux · macOS · Windows)](https://github.com/ashlrai/ashlr-plugin/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/ashlrai/ashlr-plugin/actions/workflows/ci.yml?query=branch%3Amain+event%3Apush)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

<!-- fresh:begin install -->
```bash
npm install -g ashlr-plugin@1.37.1
```
<!-- fresh:end -->

> **Fewer tokens per tool call in Codex and Claude Code: reads about −75%, greps about −27% on vercel/ai, pandas and tokio (per-call benchmark, not end to end).**
> _TS −60% · Python −63% · Rust −55%_: measured on `vercel/ai`, `pandas`, and `tokio`.
> 95% CI reported by the benchmark runner. Reproduce with `bun run scripts/run-benchmark.ts --compare`. ([full methodology](docs/benchmarks.md))

40 MCP tools that replace high-volume `Read` / `Grep` / `Edit` / `Bash` workflows with versions that return **less** without losing what matters. Claude Code gets automatic PreToolUse redirects (`ASHLR_HOOK_MODE=redirect`); Codex gets first-class plugin packaging, MCP, skills, and nudge-first hooks.

> **Requires [Bun ≥ 1.3](https://bun.sh/)**: interactive installers can offer to install Bun; piped/non-interactive installs skip that prompt and rely on MCP bootstrap if Bun is missing. Verify with `bun --version` first.
>
> ```bash
> curl -fsSL https://bun.sh/install | bash
> ```

```bash
# macOS / Linux
curl -fsSL https://plugin.ashlr.ai/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/ashlrai/ashlr-plugin/main/docs/install.ps1 | iex
```

The npm package exposes `ashlr-plugin` for CLI workflows and `ashlr-mcp` for MCP hosts. It requires Bun. From v1.36.4, use `ashlr-plugin stats`, `ashlr-plugin tools`, and the other `ashlr-plugin` commands in place of the former `ashlr` alias; `ashlr` remains available to Ashlr Hub. MCP server registration names and tool names are unchanged.

**Landing page:** [plugin.ashlr.ai](https://plugin.ashlr.ai/) · **Docs:** [plugin.ashlr.ai/docs](https://plugin.ashlr.ai/docs) · **Core library:** [`@ashlr/core-efficiency`](https://github.com/ashlrai/ashlr-core-efficiency) · **License:** MIT

> **Open-source and honestly benchmarked.** The per-call figures are reproducible on your own code with `bun run scripts/run-benchmark.ts --compare` ([methodology](docs/benchmarks.md)). Every ashlr savings figure includes a 95% CI. Telemetry is off by default. Compare against closed, self-benchmarked alternatives with `/ashlr-benchmark --compare`.

**Tested on:** Ubuntu 22.04 · macOS 14 (Sonoma) · Windows Server 2022 · TypeScript hooks (no bash required)

---

## What's new in v1.37

- **Tools act on your project**: MCP tools resolve relative paths and default folders against the folder the host launched them in, not the plugin's install folder. Phantom fleet worktrees are no longer refused.
- **Faster hooks**: each SessionStart and PostToolUse event starts one `node` launcher instead of one per hook (CPU per native Edit 712 → 319 ms in a Linux container), and SessionStart exits in about 0.6 s instead of 2.1 s.
- **Claude Code hooks detected correctly**: hooks under Claude Code no longer run in Codex nudge mode.
- **Works without Bun on PATH**: the npm bins start under node and find or explain Bun instead of failing with `env: 'bun'`.
- **Readable grep fallback**: `ashlr__grep` without a genome returns plain `path:line:text` matches, says when ripgrep stopped early, and is benchmarked against plain `rg -n` (about −27% per call).
- **Shorter edit replies**: exact, unique `ashlr__edit` matches return the header only.
- **New host ids**: `ASHLR_MCP_HOST=gemini-cli` and `cursor`.

See the [CHANGELOG](CHANGELOG.md) for the full list.

<details>
<summary>v1.36 highlights</summary>

- **Codex-native plugin packaging**: `.codex-plugin/plugin.json`, `.mcp.json`, Codex workflow skills, Codex explorer/worker agent guidance, and portable Codex hooks ship in the same package as the Claude Code plugin.
- **Reliable Codex MCP launch**: `ashlr-mcp` starts the router directly with `ASHLR_MCP_HOST=codex-cli`, workspace-aware `cwd` behavior, and `ASHLR_ALLOW_PROJECT_PATHS` support for non-plugin launch directories.
- **Codex nudge-first hooks**: Codex hooks now inject compact-tool guidance for Bash, apply_patch, Read/Grep/Glob, Edit/MultiEdit, Write, and high-value Ashlr MCP calls without forcing redirects by default.
- **Host-neutral CLI workflows**: `ashlr-plugin codex-doctor`, `ashlr-plugin codex-install --dry-run`, `ashlr-plugin codex-start`, `ashlr-plugin codex-resume`, `ashlr-plugin codex-end`, and `ashlr-plugin genome-refresh` give Codex users the same operational surface without writing Claude config.
- **Four discipline skills**: `/ashlr-search`, `/ashlr-lean-tools`, `/ashlr-genome-author`, `/ashlr-cost-refactor`. Each enforces a specific anti-waste pattern; each persists in `~/.ashlr/<name>.json`. Toggle with `/ashlr-<name> on/off`.
- **`/ashlr-efficient`**: output structure reshaper. Enforces answer-first (inverted pyramid), inline code for all identifiers, tables for 3+ item comparisons, and no transitional filler. Works standalone or alongside `/ashlr-brief`.
- **Two lifecycle hooks**: `SubagentStop` rolls up subagent savings to the session log and fires background genome consolidation; `Stop` finalises session stats with an idempotency guard. (Re-orientation after context compaction is handled by the `SessionStart` compact hook, the only event that can inject context.)
- **API-measured savings mode**: when `ANTHROPIC_API_KEY` is set, token counts upgrade from `(est.)` to `(API-measured)` once ≥10 calls have been verified via the Anthropic API. Fire-and-forget; SHA-256 cached; never blocks a tool call.
- **Benchmark transparency**: `scripts/run-benchmark.ts` now reports a 95% bootstrap confidence interval alongside the headline. New flags: `--compare` (A/B table), `--validate-tokenizer` (API spot-check of the chars/4 heuristic). See [benchmark methodology](docs/benchmarks.md).

</details>

<details>
<summary>v1.33 highlights</summary>

- **First-call savings projection**: see your annual savings extrapolated on your very first ashlr call.
- **Multi-host MCP**: works in Codex, Claude Code, Cline, Claude Desktop, Cursor, Goose, and generic MCP hosts (`ASHLR_MCP_HOST` env var).
- **`/ashlr-orchestrate-status`**: inspect past orchestration runs with per-node timings + tokens.
- **Orchestration retry + handoff budget**: per-node retry-with-backoff; HANDOFF_PAYLOAD capped at 8KB.
- **Orchestration central quota accounting**: `orchestration_usage` table for Team-tier soft-throttle.
- **Bun ≥ 1.3 prereq surfaced** + wizard restart enforcement: closes 2 fatal first-touch cliffs.
- **Orchestrator overhead bench**: per-node overhead and parallel speedup are measured by the orchestrator bench; no figure is published here until it is reproducible from this repo.
- **Pre-existing tsc errors fixed** + permanent dashboard date-drift fix via clock injection.

</details>

## What's new in v1.33 (archived)

<details>
<summary>v1.32 highlights</summary>

- **`/ashlr-orchestrate`**: multi-agent task graphs with parallel execution, dry-run renderer, and tier-gated subprocess wiring.
- **`/ashlr-orchestrate-status`**: inspect past orchestration runs with per-node telemetry.
- **Live genome**: PR-aware + commit-aware sections via git post-commit hook and GitHub webhook delta sync.
- **AI-Native discoveries**: LLM synthesizes `discovery` sections from your commit history automatically.
- **Predictive prefetch** *(Pro/Team)*: background warm-cache on every `ashlr__read` cuts repeat-hit latency.
- **PR + issue retrieval**: `ashlr__grep --include-prs --include-issues --since-days` pulls live GitHub context.
- **Freshness badges** in genome retrieval surface staleness so you trust the answer.
- **Cross-language bench (per-call, not end to end):** TS −61.3% · Python −63.1% · Rust −46.8%, about −57% averaged across tool calls. This is not a measured reduction in total session cost.
- **Founder WAD-D dashboard** at `/admin/wad-d`: daily-active records + segment breakdown + discovery propagation.

</details>

---

## Multi-host MCP

Works with Codex, Claude Code (default), [Cline](https://github.com/cline/cline), Claude Desktop, Cursor, Goose, and generic MCP hosts. The 40 MCP tools, stats accounting, and genome retrieval are host-agnostic; savings and accounting apply when the host calls Ashlr MCP tools. Codex support is packaged through `.codex-plugin/plugin.json`, `.mcp.json`, Codex skills, and `hooks/codex-hooks.json` in nudge mode. Claude-only extras remain explicitly labeled: auto redirects, status line, slash commands, and OAuth bootstrap. See [plugin.ashlr.ai/docs](https://plugin.ashlr.ai/docs) or [`docs/multi-host-mcp.md`](docs/multi-host-mcp.md) for setup snippets. For a fast Codex setup, see the [Codex quickstart](docs/codex-quickstart.md).

---

## Permissions: stop the prompts first

Run this once after install so Claude Code stops asking on every tool call:

```
/ashlr-allow
```

That adds ashlr MCP wildcards to `permissions.allow` in `~/.claude/settings.json`. It is idempotent. Run `/reload-plugins` after changing permissions, or fully quit and restart Claude Code if reload is unavailable.

---

## 10-second demo

```
# 1. Install
curl -fsSL https://plugin.ashlr.ai/install.sh | bash
# Inside Claude Code:
/plugin marketplace add ashlrai/ashlr-plugin
/plugin install ashlr@ashlr-marketplace

# 2. Use: read a large file (raw would be ~8,400 tokens)
ashlr__read  { "path": "src/server.ts" }
# Returns snipCompact view: head + tail, elided middle: ~1,700 tokens

# 3. Check savings
/ashlr-savings
```

```
Session savings  ·  ashlr-plugin v1.36.0
────────────────────────────────────────
  ashlr__read      6 calls    −42,180 tok   $0.13
  ashlr__grep      3 calls    −11,040 tok   $0.03
  ashlr__edit      2 calls     −3,200 tok   $0.01
  ─────────────────────────────────────────────
  Session total               −56,420 tok   $0.17
  Lifetime total             −284,900 tok   $0.86
  7-day sparkline   ▁▂▃▃▅▆█
```

---

## What you get

Core efficiency tools (replace built-ins with lower-token equivalents):

| MCP tool | Description |
|---|---|
| `ashlr__read` | `snipCompact` + LLM summary on files > 16 KB (Anthropic Haiku 4.5 default, ONNX/local fallback). Mean **−82.1%** on the v1.22 bench. Line numbers preserved on code files. |
| `ashlr__grep` | Genome-aware RAG when `.ashlrcode/genome/` or cloud genome exists; ripgrep fallback with LLM summary. |
| `ashlr__edit` | In-place search/replace: returns diff summary only, not the full file. Levenshtein candidates on miss. |
| `ashlr__edit_structural` | AST-aware rename (Unicode identifiers: `café`, `π`, CJK) + cross-file rename with `anchorFile` + `maxFiles` + shadowing guard + dryRun + extract-function with return-value detection (0 / 1 / N outputs). `.ts/.tsx/.js/.jsx`. |
| `ashlr__multi_edit` | Batch multiple search/replace edits in one call. |
| `ashlr__savings` | Live token-savings dashboard: session + lifetime + per-tool breakdown. |

Shell, data, and web tools:

| MCP tool | Description |
|---|---|
| `ashlr__bash` | Shell with auto-compression + pluggable summarizer registry (`servers/_bash-summarizers-registry.ts`) covering `git log`/`git diff`/`git show`, `ls`, `ps`, `npm ls`, unified test-runner output, `tsc`, and npm/bun/yarn/pnpm installs. Long-running commands survive timeouts via process-group SIGKILL. |
| `ashlr__bash_start` / `_tail` / `_stop` / `_list` | Long-running background command control plane. |
| `ashlr__sql` | SQLite + Postgres one-shot. `explain` and `schema` modes. LLM summary on 100+ row results. |
| `ashlr__http` | HTTP fetch with readable-extract (HTML), array-elide (JSON), and private-host safety. |
| `ashlr__webfetch` | Fetch + extract web pages with token budget. LLM summarization kicks in at 4 KB (web content is denser than code), 100 KB hard cap. |
| `ashlr__logs` | Tail with level filter + dedupe + LLM summary. |
| `ashlr__diff` | Adaptive git diff (stat/summary/full) with LLM summary on big diffs. |
| `ashlr__diff_semantic` | Semantic diff with meaning-aware change grouping. |
| `ashlr__test` | Structured test-runner output parser: bun/vitest/jest/pytest/go test. Compresses runner noise into one failure block per failure. |

Codebase navigation:

| MCP tool | Description |
|---|---|
| `ashlr__tree` | gitignore-aware directory tree with per-dir truncation + size/LOC modes. |
| `ashlr__glob` | gitignore-aware file glob with size/LOC metadata. |
| `ashlr__ls` | Directory listing with size metadata. |
| `ashlr__orient` | Codebase orientation: entry points, key files, dependency graph. |

Genome + GitHub:

| MCP tool | Description |
|---|---|
| `ashlr__genome_propose` / `_consolidate` / `_status` | Active genome scribe loop: keeps `.ashlrcode/genome/` current as you code. |
| `ashlr__issue` / `ashlr__pr` | GitHub issue and PR read ops. |
| `ashlr__issue_create` / `ashlr__issue_close` | GitHub issue write ops. Self-approval guard + `ASHLR_REQUIRE_GH_CONFIRM=1` opt-in confirmation. |
| `ashlr__pr_comment` / `ashlr__pr_approve` | GitHub PR write ops. `pr:"current"` resolves via `gh pr view`. No destructive ops (no merge/close/delete). |
| `ashlr__ask` | Ask a question, get a structured answer with citations. |

See [docs/architecture.md](./docs/architecture.md) for the full tool registry and router layout.

---

## Pro cloud

ashlr Pro connects to a hosted backend at `https://api.ashlr.ai`, unlocking
features that require server-side state:

| Feature | What it does |
|---|---|
| **Cross-machine stats** | Aggregate token savings across all your machines. `GET /v1/stats/aggregate` returns `machine_count` + combined lifetime totals. |
| **Hosted summarizer** | `POST https://api.ashlr.ai/llm/summarize`: cloud inference via xAI Grok 4.3. Falls back to local summarization or snipCompact when unavailable. |
| **Team genome** | Encrypted genome sync across teammates. DEKs wrapped with X25519: only key-holders can decrypt (`/ashlr-genome-team-init`). |

**Privacy:** telemetry is off by default and explicit opt-in only (`ASHLR_TELEMETRY=on`). The `sessionId`
is an opaque 16-char hex value per session: never your user identity: and
is stored server-side as a SHA-256 hash. File paths and content are never
sent. See [plugin.ashlr.ai/docs](https://plugin.ashlr.ai/docs) for the full privacy
contract (internal: [`docs/telemetry.md`](./docs/telemetry.md)).

**Production URL:** `https://api.ashlr.ai`

The `/ashlr-doctor` command includes a **cloud** check that pings
`/healthz` with a 3-second timeout and reports latency. Set
`ASHLR_API_URL_DISABLE=1` to suppress it in offline environments.

---

## Status-line

The Claude Code status bar shows session savings, a 7-day sparkline, and optional context pressure. The examples below are representative; counters and optional badges depend on your session and settings.

```
┌─────────────────────────────────────────────┐
│  ashlr  −0 tok  $0.00  ▁▁▁▁▁▁▁  idle       │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  ashlr  −12,480 tok  $0.04  ▁▂▃▄▅▆█  ██    │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  ashlr  −48,200 tok  $0.14  ▁▃▅▆██  ▓▓▓ !! │
└─────────────────────────────────────────────┘
```

`!!` appears when context pressure is high. Install:

```bash
bun run ~/.claude/plugins/cache/ashlr-marketplace/ashlr/<version>/scripts/install-status-line.ts
```

| Example output | Meaning |
|---|---|
| `ashlr · ◦ · ▁▁▁▁▁▁▁ · session +0 ≈$0.00` | No savings recorded in this session yet. |
| `ashlr · ↑ · ▁▂▃▄▅▆█ · session ↑+12.5K ≈$0.01 · lifetime +42K (est.)` | Session savings and estimated lifetime savings; `↑` marks recent activity. |
| `ashlr · ctx: 92% · session +48.2K ≈$0.04` | Context usage was available from Claude Code input. `ctx:` is omitted when no usable usage/limit pair is provided. |

The optional `statusLine` settings live under the `ashlr` key in `~/.claude/settings.json`. Omitted booleans use the defaults shown here.

| Field | Default | Effect |
|---|---:|---|
| `statusLine` | `true` | Master switch; `false` hides the status line. |
| `statusLineSession` | `true` | Show the current session's saved-token count and cost estimate. |
| `statusLineLifetime` | `true` | Show lifetime saved-token count when it is greater than zero. |
| `statusLineTips` | `true` | Add a rotating tip, or an eligible upgrade nudge, when it fits. |
| `statusLineSparkline` | `true` | Show the 7-day activity sparkline and heartbeat. |
| `statusLineUpgradeNudge` | `true` | Allow the free-tier 50K-session-savings upgrade nudge; set `false` to silence it. |

For example, to hide tips and lifetime totals while keeping session savings:

```json
{
  "ashlr": {
    "statusLineTips": false,
    "statusLineLifetime": false
  }
}
```

The status line is Claude Code-specific. Codex users can inspect savings with `ashlr-plugin stats --json` or the `ashlr__savings` MCP tool.

---

## Install

**Prerequisites:** **[Bun ≥ 1.3](https://bun.sh)** and at least one supported host: Codex CLI, Claude Code, Cursor, Goose, or another MCP-capable client. Interactive installers can offer to install Bun; piped/non-interactive installs skip that prompt and rely on MCP bootstrap if Bun is missing. Verify with `bun --version` first, or install: `curl -fsSL https://bun.sh/install | bash`. No account, no API key.

```bash
# Claude Code one-liner
curl -fsSL https://plugin.ashlr.ai/install.sh | bash
```

For Codex:

```bash
git clone https://github.com/ashlrai/ashlr-plugin
cd ashlr-plugin && bun install
codex plugin marketplace add ashlrai/ashlr-plugin
codex plugin add ashlr@ashlr-marketplace
bun run scripts/cli.ts codex-doctor --json
```

For Claude Code:

```
/plugin marketplace add ashlrai/ashlr-plugin
/plugin install ashlr@ashlr-marketplace
/reload-plugins
```

Verify with `/ashlr-status`. If `/reload-plugins` is unavailable or `/ashlr-status` does not see the plugin, fully quit and restart Claude Code.

**Manual install:**

```bash
git clone https://github.com/ashlrai/ashlr-plugin \
  ~/.claude/plugins/cache/ashlr-marketplace/ashlr
cd ~/.claude/plugins/cache/ashlr-marketplace/ashlr && bun install
# Then inside Claude Code:
# /plugin marketplace add ashlrai/ashlr-plugin
# /plugin install ashlr@ashlr-marketplace
# /reload-plugins
```

---

## Provider base URLs

The plugin's own provider calls (the summarizer and token-count calls to Anthropic, the genome reachability probes for Anthropic and OpenAI, and the Ollama checks in `/ashlr-ollama-setup` and `genome-init`) read the usual environment variables and keep their old defaults when none is set:

| Variable | Default | Form |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | root, without `/v1` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | includes `/v1` |
| `OLLAMA_HOST` | `http://localhost:11434` | `host`, `host:port`, `:port` or a full URL |

Trailing slashes are trimmed. Pointing these at a gateway such as a LiteLLM proxy or a Phantom proxy is therefore possible, because the plugin just sends its requests to whatever URL you set. Only the URL handling is covered by tests here; the plugin has not been tested against any specific gateway, and what a gateway does with your keys and requests is documented by that gateway. Not covered: the Ollama probe in the session greeting and the optional `ASHLR_EMBED_URL` embedding endpoint, which keep their own settings.

Under a Phantom session these variables are set for you; see [Plugs into Phantom Secrets](#plugs-into-phantom-secrets).

---

## Plugs into Phantom Secrets

[Phantom Secrets](https://github.com/ashlrai/phantom-secrets) swaps the real keys in a project for scoped `phm_` placeholders and swaps them back at an authenticated local proxy: the agent can use the key but never sees it. The plugin runs inside that boundary with no extra wiring. `phantom exec` hands the child `phm_` placeholders and points `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` at `http://127.0.0.1:<port>/<route>/_phantom/<token>/`; the plugin sends whatever key and base URL it is given, so the placeholder flows through unchanged and the proxy does the swap.

```bash
# Hosts run inside the Phantom boundary
phantom exec -- claude
phantom exec -- codex

# Plugin scripts work the same way
phantom exec -- bun run scripts/doctor.ts
phantom exec -- bun run scripts/run-benchmark.ts --validate-tokenizer
```

Inside a session:

- **`/ashlr-doctor` reports it.** A `phantom exec` line shows the proxy port, which provider keys hold `phm_` placeholders, and which base URLs point at the session's proxy (session token redacted). It warns when a `phm_` placeholder sits outside a session, when a placeholder's base URL does not point at the proxy, or when a key is a `phm:` reference. The doctor also lists whether the `phantom` CLI is installed and its version; it runs only `phantom --version` and never reads or reveals secret values.
- **Optional preflight.** `ASHLR_PHANTOM_PREFLIGHT=1` (or `strict`) makes the doctor also run Phantom's value-free `phantom agent doctor --json` and report its verdict as a `phantom preflight` line. See [docs/phantom-preflight.md](docs/phantom-preflight.md).
- **Benchmarks adapt.** `run-benchmark --validate-tokenizer` skips its API sample when the key would not work from that process, and says why.
- **Hard guarantees.** Detection uses variable names, the `phm_` / `phm:` prefixes, and the base URL host and port only. The plugin never resolves `phm:` references, never runs `phantom reveal`, and never prints key values.

The Phantom fleet mod in [`mods/`](mods/README.md) goes further on Claude Code **2.1.309+** with a pinned [Locus](https://github.com/ashlrai/locus) binding and compatible Phantom/Locus CLIs: governed model routing (`phm router select`), a `/top` fleet pane, `/peers`, and person-acknowledged `/send`. `/ashlr-fleet` explains it inside a session. It ships from the git plugin only (the npm package omits `mods/`), and some of its CLI contracts are still proposals upstream: `mods/README.md` marks what is verified.

The full `phantom exec` contract, including LiteLLM notes and the strict-gateway variables, lives in [docs/PHANTOM-USAGE.md](docs/PHANTOM-USAGE.md). Session detection and the doctor line are covered by `__tests__/phantom-exec.test.ts` and `__tests__/doctor-phantom.test.ts`; the plugin has not been tested against a live Phantom session here.

---

## Commands

Use `ashlr-plugin` in a terminal and slash commands inside Claude Code. MCP hosts call tools through `ashlr-mcp`.

| Task | Terminal | Claude Code |
|---|---|---|
| Start here | `ashlr-plugin codex-doctor` for Codex diagnostics | `/ashlr-start` |
| Check savings | `ashlr-plugin stats --json` | `/ashlr-savings` or `/ashlr-dashboard` |
| Inspect tools | `ashlr-plugin tools` | `/ashlr-help` |
| Preview Codex setup | `ashlr-plugin codex-install --dry-run` | See [multi-host setup](docs/multi-host-mcp.md) |
| Refresh changed genome files | `ashlr-plugin genome-refresh` | `/ashlr-genome-loop` to inspect the automatic loop |
| Decode the status line | See [status-line setup](#status-line) | `/ashlr-legend` |

See the [complete command reference](docs/commands.md) for every shipped slash command, terminal command, aliases, and source links. Claude Code slash commands are not terminal subcommands. The CLI executable is `ashlr-plugin`; `ashlr` belongs to Ashlr Hub.

---

## Free vs Pro

The free tier is the product: 40 MCP tools, the full slash-command catalog, the full genome scribe loop, and every benchmark included. No account required.

Pro ($12/mo, 7-day trial) adds cloud infrastructure for developers who need it: cross-machine stats sync, hosted embedding retrieval, cloud LLM summarizer (no local Ollama required), and a live auto-updating savings badge. Team ($24/user/mo, min 3) adds shared encrypted team genome, org savings dashboard, policy packs, and SSO.

Run `/ashlr-upgrade` to upgrade, or see [plugin.ashlr.ai/docs/pro/pricing](https://plugin.ashlr.ai/docs/pro/pricing) for the full comparison.

---

## Architecture

See [plugin.ashlr.ai/docs/contributing/architecture](https://plugin.ashlr.ai/docs/contributing/architecture) for how the tools, hooks, and genome scribe loop fit together. Internal notes: [`docs/architecture.md`](./docs/architecture.md).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history.

## Part of the Ashlr ecosystem

The Ashlr plugin is one of the open-source tools from [Ashlr](https://ashlr.ai), a forward-deployed engineering company. Its siblings: [Lexicon](https://github.com/ashlrai/lexicon), [Locus](https://github.com/ashlrai/locus), [Phantom Secrets](https://github.com/ashlrai/phantom-secrets), [Ashlr Stack](https://github.com/ashlrai/ashlr-stack), [Ashlr Markdown](https://github.com/ashlrai/ashlr-md).

## Contributing

Issues and PRs are welcome. Look for [`good first issue`](https://github.com/ashlrai/ashlr-plugin/labels/good%20first%20issue) to get started, and read [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately per [SECURITY.md](SECURITY.md).

## License

MIT: [LICENSE](./LICENSE).
