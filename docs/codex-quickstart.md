# Codex quickstart

Set up ashlr-plugin in Codex CLI and verify that its tools are available.

Agents start with the JSON CLI, then register MCP:

```bash
npm install -g ashlr-plugin
ashlr-plugin --ashlr-handshake
ashlr-plugin codex-doctor --json
ashlr-plugin codex-install --dry-run --json
```

The full snippets are in [../llms-full.txt](../llms-full.txt).

## Requirements

- [Codex CLI](https://github.com/openai/codex) with plugin support (`codex plugin --help` lists the plugin commands)
- [Bun 1.3 or newer](https://bun.sh/)

Check Bun with `bun --version`. If it is missing, install it using the instructions at [bun.sh](https://bun.sh/).

## Install the plugin

From a shell, register the Ashlr marketplace, install the plugin, and confirm it is installed:

```bash
codex plugin marketplace add ashlrai/ashlr-plugin
codex plugin add ashlr@ashlr-marketplace
codex plugin list
```

The list should show `ashlr`. Restart Codex if it was already open. The plugin package includes the MCP server, Codex skills, and nudge-first hooks. The hooks provide tool guidance in context; they do not redirect or block Codex's native tools.

## Check the installation

Run the packaging doctor from a terminal:

```bash
ashlr-plugin codex-doctor --json
```

If the `ashlr-plugin` command is not on `PATH`, run it from a clone of this repository:

```bash
bun run scripts/cli.ts codex-doctor --json
```

To list the tool names the plugin exposes without opening Codex:

```bash
ashlr-plugin tools
```

In Codex, confirm the `ashlr__` tools are listed, then try `ashlr__savings` or use `ashlr__read` on a project file. Ashlr tracks savings when Codex calls its MCP tools. Codex-native calls continue to work normally.

## Inspect savings

From a shell, read the local ledger as JSON:

```bash
ashlr-plugin stats --json
```

From a clone: `bun run scripts/cli.ts stats --json`.

Or ask Codex to call `ashlr__savings` for a readable session and lifetime summary. The ledger is stored locally at `~/.ashlr/stats.json`.

## MCP-only setup

Install the command, then paste this into `~/.codex/config.toml`. `ashlr-mcp` must be on PATH. There is no path to edit.

```bash
npm install -g ashlr-plugin
```

```toml
[mcp_servers.ashlr]
command = "ashlr-mcp"
args = []
cwd = "."
env = { ASHLR_MCP_HOST = "codex-cli", ASHLR_CODEX_HOOK_MODE = "nudge" }
```

Restart Codex, then run `codex mcp list` to confirm `ashlr` is configured. When Codex starts the MCP server outside the project directory, pass `cwd` to Ashlr tool calls or set `ASHLR_ALLOW_PROJECT_PATHS` in this MCP server's environment to allow the project path. See [multi-host MCP setup](multi-host-mcp.md#openai-codex-cli-codexconfigtoml) for details.

To preview the config changes a packaged install would make, run `bun run scripts/cli.ts codex-install --dry-run --json` from a clone.

## Host-specific features

The MCP tools and savings ledger work with Codex. Claude Code-specific features such as automatic tool redirects, the animated status line, slash commands, and OAuth bootstrap do not run in Codex. Codex users can check savings with `ashlr-plugin stats --json` or `ashlr__savings`.
