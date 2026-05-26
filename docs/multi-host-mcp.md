# Multi-host MCP setup

`ashlr-plugin` ships its 40 efficiency tools as a single MCP stdio server. The
server is host-agnostic — any client that speaks the [Model Context Protocol](https://modelcontextprotocol.io/)
can wire it up and get the same `−57%` token savings the README headlines.

| Host                  | Status     | Hook redirects | Status line | Slash commands |
| --------------------- | ---------- | -------------- | ----------- | -------------- |
| **Claude Code**       | ✅ Default | ✅ yes         | ✅ yes      | ✅ yes         |
| **Cline (OSS)**       | ✅ Working | ❌ no (1)      | ❌ no       | n/a            |
| **Claude Desktop**    | ✅ Working | ❌ no (1)      | ❌ no       | n/a            |
| **OpenAI Codex CLI**  | ✅ Working | ❌ no (1)      | ❌ no       | n/a            |
| **Generic MCP host**  | ✅ Working | ❌ no (1)      | ❌ no       | n/a            |

> (1) Hook redirects (`ASHLR_HOOK_MODE=redirect` that auto-rewrites the host's
> built-in `Read`/`Grep`/`Edit` to `ashlr__*`) are Claude-Code-specific because
> they rely on Claude Code's PreToolUse hook system. On other hosts you call
> `ashlr__read` / `ashlr__grep` / `ashlr__edit` directly. Same tools, same
> savings, one extra prefix.

## How host detection works

Every host's MCP server config sets the env var `ASHLR_MCP_HOST` so the
server knows where it's running:

```
ASHLR_MCP_HOST=claude-code    # default — preserved for back-compat
ASHLR_MCP_HOST=cline
ASHLR_MCP_HOST=claude-desktop
ASHLR_MCP_HOST=codex-cli
ASHLR_MCP_HOST=generic        # safe default for anything else
```

If the env var is missing, the server infers `claude-code` when it sees
`CLAUDE_SESSION_ID` / `CLAUDE_PLUGIN_ROOT` / `CLAUDE_CODE_MODEL`, and
`generic` otherwise. The startup banner echoes the resolved host:

```
[ashlr-router] starting · 40 tools registered · version=1.29.0 · host=cline
```

## Cline (cline_mcp_settings.json)

Cline's MCP config lives in your OS-specific Cline settings dir (see
[Cline MCP docs](https://github.com/cline/cline/blob/main/docs/mcp/README.md)).
The file is typically at:

- macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Linux: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Windows: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`

Add this `mcpServers` entry (replace `/abs/path/to/ashlr-plugin` with where
you cloned the repo):

```json
{
  "mcpServers": {
    "ashlr": {
      "command": "bun",
      "args": ["run", "/abs/path/to/ashlr-plugin/servers/_router.ts"],
      "env": {
        "ASHLR_MCP_HOST": "cline"
      }
    }
  }
}
```

Restart Cline. The tool palette will surface `ashlr__read`, `ashlr__grep`,
`ashlr__edit`, `ashlr__bash`, `ashlr__savings`, and 35 others.

**Don't have Bun?** Use the node trampoline instead — it auto-installs Bun
on first run:

```json
{
  "command": "node",
  "args": ["/abs/path/to/ashlr-plugin/scripts/bootstrap.mjs", "servers/_router.ts"],
  "env": { "ASHLR_MCP_HOST": "cline" }
}
```

## Claude Desktop (claude_desktop_config.json)

Claude Desktop reads `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS (and the equivalent `%APPDATA%\Claude\claude_desktop_config.json` on
Windows). Add:

```json
{
  "mcpServers": {
    "ashlr": {
      "command": "bun",
      "args": ["run", "/abs/path/to/ashlr-plugin/servers/_router.ts"],
      "env": {
        "ASHLR_MCP_HOST": "claude-desktop"
      }
    }
  }
}
```

Quit and reopen Claude Desktop. The tool count appears next to the input box.

## OpenAI Codex CLI (~/.codex/config.toml)

Codex CLI's MCP config uses TOML. Add this block to `~/.codex/config.toml`:

```toml
[mcp_servers.ashlr]
command = "bun"
args = ["run", "/abs/path/to/ashlr-plugin/servers/_router.ts"]
env = { ASHLR_MCP_HOST = "codex-cli" }
```

Run `codex` — the tools register on startup.

## Generic MCP host

Any MCP-capable client (in-house tooling, experimental hosts, …) can speak
to the ashlr server over stdio. Spawn it directly:

```bash
ASHLR_MCP_HOST=generic bun run /abs/path/to/ashlr-plugin/servers/_router.ts
```

The server speaks JSON-RPC 2.0 on stdin/stdout. Send `initialize` →
`tools/list` → `tools/call` per the MCP spec. The server emits its
startup banner on stderr (won't interfere with stdio protocol).

## What works in every host

These features are host-agnostic and Just Work everywhere:

- **All 40 MCP tools** — `ashlr__read`, `ashlr__grep`, `ashlr__edit`, plus
  the bash, http, sql, github, genome, and orchestration families.
- **Stats accounting** — writes to `~/.ashlr/stats.json` regardless of
  host. `ashlr stats --json` CLI works everywhere Bun runs.
- **Genome retrieval** — `.ashlrcode/genome/` lookups work identically.
  Cloud-genome sync requires Pro/Team auth (see limitations below).
- **Telemetry consent** — `ASHLR_TELEMETRY_OPT_IN=1` honored identically.
  No host ever auto-enables it.
- **Per-handler crash isolation** — one tool throwing won't kill the
  process. Stack traces redirect to `~/.ashlr/crash-dumps/`.

## What doesn't work outside Claude Code (and why)

These are Claude-Code-specific surfaces. Other hosts have their own
conventions; we don't try to fight them.

- **PreToolUse / PostToolUse / SessionStart / SessionEnd hooks** — declared
  in `.claude-plugin/plugin.json` and `hooks/hooks.json`. Claude Code reads
  these and fires the corresponding TypeScript handlers. No other host
  understands that wire format, so the hooks simply don't fire — and the
  MCP server doesn't depend on them firing (graceful degradation).
- **Hook-based auto-redirects** (`ASHLR_HOOK_MODE=redirect`) — only Claude
  Code intercepts its built-in `Read`/`Grep`/`Edit` and rewrites them to
  `ashlr__*`. In Cline/Desktop/Codex you call `ashlr__*` directly.
- **Slash commands** (`/ashlr-doctor`, `/ashlr-savings`, …) — these are
  Claude Code prompt-templates in `commands/*.md`. Other hosts don't have
  an equivalent surface. The same diagnostics live in the `ashlr` CLI
  (`ashlr stats --json`, `ashlr tools`, `ashlr version`).
- **Status line** (the `−$X` savings ticker) — Claude Code's `statusLine`
  manifest extension. Other hosts render their own footer.
- **Pro/Team auth** — currently bootstrapped from
  `~/.claude/.credentials.json` (the OAuth token Claude Code stores after
  `/login`). Non-CC users can set `ANTHROPIC_API_KEY` for LLM summarization;
  Pro/Team sign-in via `/ashlr-upgrade` is Claude-Code-only until a
  host-agnostic auth flow lands. Use `ASHLR_PRO_ASSUME=1` for trial-style
  unlock if you've already activated Pro on this machine via Claude Code.

## Troubleshooting

**"command not found: bun" when launching the MCP server**
Install Bun once: `curl -fsSL https://bun.sh/install | bash` (or use the
node trampoline shown above — it auto-installs Bun on first invocation).

**Tools register but every call returns "no stats yet"**
Stats are written on tool _call_, not on registration. Run any `ashlr__*`
tool from your host once, then `ashlr stats --json` will return data.

**Session counter stuck at 0 across hosts**
The PPID-derived fallback session id is per-process. Different hosts spawn
the MCP server with different PIDs → different session buckets. That's
expected. The lifetime totals are still globally accurate.

**Want the hook-based auto-redirect feel in Cline?**
File an issue — we're tracking interest in a Cline-native equivalent
that uses Cline's pre-tool-execution hooks (when those land upstream).
