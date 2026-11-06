# ashlr in other MCP hosts

Ashlr is a suite of MCP servers. The servers speak the standard Model Context
Protocol over stdio and work in any MCP-compatible host, not just Claude Code.

This directory contains ready-made config snippets for Cursor and Goose. Codex
uses the repo-root `.codex-plugin/plugin.json` and `.mcp.json` files instead.

---

## Install

```bash
npm install -g ashlr-plugin
ashlr-plugin tools --json
```

That puts `ashlr-plugin` and `ashlr-mcp` on PATH. The host snippets below call `ashlr-mcp`. There is no path to edit.

---

## Cursor

Cursor reads MCP server config from `.cursor/mcp.json` in your project, or from
`~/.cursor/mcp.json` globally.

This replaces `.cursor/mcp.json`. Merge it with an existing file if you already have other servers.

```bash
mkdir -p .cursor
cat > .cursor/mcp.json <<'EOF'
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
EOF
```

Restart Cursor. The 54 MCP tools will appear in the MCP panel.

---

## Goose

Goose reads extensions from a recipe file passed at run time.

This writes `ashlr-goose.yaml` in the current directory and runs it.

```bash
cat > ashlr-goose.yaml <<'EOF'
version: "1.0"
title: ashlr token-efficiency suite
description: Registers the ashlr MCP router as one Goose extension.
extensions:
  - name: ashlr
    type: stdio
    cmd: ashlr-mcp
    args: []
    env:
      ASHLR_MCP_HOST: generic
EOF
goose run --recipe ashlr-goose.yaml
```

---

## Caveats

The following features are host-specific and are not available in Cursor or
Goose:

- **Claude slash commands** (`/ashlr-savings`, `/ashlr-genome-init`, etc.) are
  defined in `.claude-plugin/plugin.json`. Codex has separate workflow skills
  under `skills/` via `.codex-plugin/plugin.json`.
- **Status line**: the token-savings counter in the Claude Code terminal is
  wired to Claude Code's `statusLine` hook.
- **Claude redirect hooks**: automatic redirect mode is Claude-only. Codex has
  nudge-first hooks. Cursor and Goose expose MCP tools directly.

The underlying MCP tools (`ashlr__read`, `ashlr__grep`, `ashlr__edit`, etc.)
work identically in any host. Token savings are still tracked: the stats server
writes to `~/.ashlr/stats.json` on every call regardless of the host.

### Shell prompt integration

If you want a savings counter in your shell prompt, run the status-line script
as a subshell command:

```bash
bun run scripts/savings-status-line.ts
```

The script reads `~/.ashlr/stats.json` and prints a compact savings summary
suitable for embedding in any shell prompt.

---

## Tools included

The current router exposes 54 tools from one MCP server. Run:

```bash
ashlr-plugin tools
```

Core tools include `ashlr__read`, `ashlr__grep`, `ashlr__edit`,
`ashlr__multi_edit`, `ashlr__bash`, `ashlr__tree`, `ashlr__savings`, and the
genome tools.
