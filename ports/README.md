# ashlr in other MCP hosts

Ashlr is a suite of MCP servers. The servers speak the standard Model Context
Protocol over stdio and work in any MCP-compatible host, not just Claude Code.

This directory contains ready-made config snippets for Cursor and Goose. Codex
uses the repo-root `.codex-plugin/plugin.json` and `.mcp.json` files instead.

---

## Install

1. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/ashlrai/ashlr-plugin
   cd ashlr-plugin
   bun install
   ```

2. Note the absolute path to your clone. You will substitute it for
   `<ASHLR_PLUGIN_ROOT>` in the config files below.

The preferred MCP entry point is `scripts/ashlr-mcp.ts` or the package bin
`ashlr-mcp`. It launches the single router process with all 40 tools. The
legacy `scripts/mcp-entrypoint.sh` snippets are retained for older host
configs that still expect individual server files.

---

## Cursor

Cursor reads MCP server config from `.cursor/mcp.json` in your project, or from
`~/.cursor/mcp.json` globally.

Copy `ports/cursor/mcp.json` to one of those locations, then replace every
occurrence of `<ASHLR_PLUGIN_ROOT>` with the absolute path to your clone:

```bash
# Example using sed
ASHLR_ROOT="/home/you/ashlr-plugin"
sed "s|<ASHLR_PLUGIN_ROOT>|$ASHLR_ROOT|g" \
  ports/cursor/mcp.json > ~/.cursor/mcp.json
```

Restart Cursor. The 40 ashlr tools will appear in the MCP panel.

---

## Goose

Goose reads extensions from a recipe file passed at run time.

Copy `ports/goose/recipe.yaml`, replace `<ASHLR_PLUGIN_ROOT>`, then run:

```bash
ASHLR_ROOT="/home/you/ashlr-plugin"
sed "s|<ASHLR_PLUGIN_ROOT>|$ASHLR_ROOT|g" \
  ports/goose/recipe.yaml > my-ashlr-recipe.yaml

goose run --recipe my-ashlr-recipe.yaml
```

---

## Caveats

The following features are host-specific and are not available in Cursor or
Goose:

- **Claude slash commands** (`/ashlr-savings`, `/ashlr-genome-init`, etc.) —
  defined in `.claude-plugin/plugin.json`. Codex has separate workflow skills
  under `skills/` via `.codex-plugin/plugin.json`.
- **Status line** — the animated token-savings counter in the Claude Code
  terminal is wired to Claude Code's `statusLine` hook.
- **Claude redirect hooks** — automatic redirect mode is Claude-only. Codex has
  nudge-first hooks; Cursor and Goose expose MCP tools directly.

The underlying MCP tools (`ashlr__read`, `ashlr__grep`, `ashlr__edit`, etc.)
work identically in any host. Token savings are still tracked: the stats server
writes to `~/.ashlr/stats.json` on every call regardless of the host.

### Shell prompt integration

If you want a savings counter in your shell prompt, run the status-line script
as a subshell command:

```bash
# bash / zsh — add to PS1 or PROMPT
PS1='$(bun run /path/to/ashlr-plugin/scripts/savings-status-line.ts) \$ '
```

The script reads `~/.ashlr/stats.json` and prints a compact savings summary
suitable for embedding in any shell prompt.

---

## Tools included

The current router exposes 40 tools from one MCP server. Run:

```bash
ashlr tools
```

Core tools include `ashlr__read`, `ashlr__grep`, `ashlr__edit`,
`ashlr__multi_edit`, `ashlr__bash`, `ashlr__tree`, `ashlr__savings`, and the
genome tools.
