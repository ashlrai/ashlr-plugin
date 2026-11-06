# Multi-host MCP setup

ashlr-plugin ships 54 MCP tools on one stdio server, `ashlr-mcp`. Savings are recorded when the host calls those tools. Claude Code can also redirect its built-in tools. Codex nudges. Other hosts call `ashlr__*` tools directly.

Agent index: [../../llms.txt](../llms.txt). Copy-paste reference: [../../llms-full.txt](../llms-full.txt).

## Install the command

```bash
npm install -g ashlr-plugin
ashlr-plugin tools --json
```

`ashlr-mcp` is then on PATH. The snippets below use that command. Do not substitute a file path.

| Host | Hooks | Status line | Slash commands |
| --- | --- | --- | --- |
| Claude Code | redirect | yes | yes |
| Codex CLI | nudge | no | skills |
| Cursor | no | no | no |
| Claude Desktop | no | no | no |
| Cline | no | no | no |
| Goose | no | no | no |
| Generic MCP | no | no | no |

Hook redirects (`ASHLR_HOOK_MODE=redirect`) depend on Claude Code's PreToolUse hook. Codex uses `hooks/codex-hooks.json` and keeps native tools allowed.

## Claude Code

Plugin install (hooks, slash commands, status line):

```bash
curl -fsSL https://plugin.ashlr.ai/install.sh | bash
```

```
/plugin marketplace add ashlrai/ashlr-plugin
/plugin install ashlr@ashlr-marketplace
/reload-plugins
```

MCP only. Project file `.mcp.json`:

```json
{
  "mcpServers": {
    "ashlr": {
      "command": "ashlr-mcp",
      "args": [],
      "env": {
        "ASHLR_MCP_HOST": "claude-code"
      }
    }
  }
}
```

## Cursor

Project file `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ashlr": {
      "command": "ashlr-mcp",
      "args": [],
      "env": {
        "ASHLR_MCP_HOST": "cursor"
      }
    }
  }
}
```

Restart Cursor. Confirm `ashlr__read` is listed.

## OpenAI Codex CLI (~/.codex/config.toml)

Plugin install:

```bash
codex plugin marketplace add ashlrai/ashlr-plugin
codex plugin add ashlr@ashlr-marketplace
ashlr-plugin codex-doctor --json
```

Preview the config write without applying it:

```bash
ashlr-plugin codex-install --dry-run --json
```

MCP only. Add this block to `~/.codex/config.toml`:

```toml
[mcp_servers.ashlr]
command = "ashlr-mcp"
args = []
cwd = "."
env = { ASHLR_MCP_HOST = "codex-cli", ASHLR_CODEX_HOOK_MODE = "nudge" }
```

If Codex starts the server outside the project, pass `cwd` on tool calls or set `ASHLR_ALLOW_PROJECT_PATHS` in this server's env. Details: [codex-quickstart.md](codex-quickstart.md).

## Other hosts

Same JSON shape as Cursor. Set `ASHLR_MCP_HOST` to the host id:

```
ASHLR_MCP_HOST=claude-code
ASHLR_MCP_HOST=claude-desktop
ASHLR_MCP_HOST=cline
ASHLR_MCP_HOST=codex-cli
ASHLR_MCP_HOST=cursor
ASHLR_MCP_HOST=gemini-cli
ASHLR_MCP_HOST=generic
```

If the variable is missing, the server uses `claude-code` when it sees `CLAUDE_SESSION_ID`, `CLAUDE_PLUGIN_ROOT`, or `CLAUDE_CODE_MODEL`. Otherwise it uses `generic`.

Goose recipe: [../ports/README.md](../ports/README.md).

A generic host can also run:

```bash
ASHLR_MCP_HOST=generic ashlr-mcp
```

The server speaks MCP over stdio. Logs go to stderr.

## What every host gets

- 54 MCP tools, including `ashlr__read`, `ashlr__grep`, and `ashlr__edit`. `ashlr__pipe` stays off until `ASHLR_PIPE_ENABLE=1`.
- A ledger at `~/.ashlr/stats.json`. Read it with `ashlr-plugin stats --json`.
- Genome lookup from `.ashlrcode/genome/` when that directory exists.
- Telemetry stays off unless `ASHLR_TELEMETRY=on`.

Claude Code slash commands are prompt files in `commands/`. The same checks on other hosts are `ashlr-plugin stats --json`, `ashlr-plugin tools --json`, and `ashlr-plugin codex-doctor --json`.

## Troubleshooting

**`ashlr-mcp` is not found.** Run `npm install -g ashlr-plugin` and open a new shell. The program looks for Bun on PATH and in `~/.bun/bin`.

**`stats --json` is an empty ledger.** Stats are written when a tool runs, not when it registers. Call `ashlr__read` once, then run `ashlr-plugin stats --json` again.

**Session totals differ by host.** Each host process gets its own session bucket. Lifetime totals still add up.
