# ashlr for VS Code

**ashlr** is a token-efficiency layer for AI coding tools. It replaces high-cost built-in tools (Read, Edit, Grep) with smarter alternatives that send 40–60 % fewer tokens to the model — saving real money on every session.

This VS Code extension is the UX companion to the ashlr-plugin. It reads the savings data that the ashlr MCP servers write to `~/.ashlr/stats.json` and surfaces it inside VS Code.

> If you haven't installed the ashlr plugin yet, start at [plugin.ashlr.ai](https://plugin.ashlr.ai). The plugin installs into Claude Code or Cursor in under a minute.

---

## Features

- **Status bar** — `ashlr · session +12.4k · lifetime +840k` appears in the bottom-right corner. Updates every 2 seconds. Click to open the dashboard.
- **Dashboard webview** — hero tiles (session / lifetime / best day), per-tool bar chart, 7-day and 30-day sparklines, projected annual savings.
- **Gutter badges** — inline savings estimates next to `ashlr__read`, `ashlr__edit`, and `ashlr__grep` call sites in the active editor. Estimates are based on the referenced file size.
- **Command palette** — five commands for common ashlr operations (see below).

---

## Commands

| Command | Description |
|---------|-------------|
| `ashlr: Show Dashboard` | Opens the savings dashboard webview. |
| `ashlr: Open Genome Folder` | Reveals `.ashlrcode/genome/` in the Explorer (creates it if absent). |
| `ashlr: Run Benchmark` | Runs `scripts/run-benchmark.ts` in a new terminal (requires the plugin repo to be the workspace root). |
| `ashlr: Show Savings` | Renders a plain-text savings summary panel. |
| `ashlr: Sign in to Pro` | Opens [plugin.ashlr.ai/signin](https://plugin.ashlr.ai/signin) in your browser. |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `ashlr.statsPath` | `""` | Path to `stats.json`. Leave empty to use `~/.ashlr/stats.json`. |
| `ashlr.pollIntervalMs` | `2000` | How often (ms) the status bar polls `stats.json`. |
| `ashlr.showGutterBadges` | `true` | Show inline savings badges next to Read/Edit calls. |

---

## MCP wiring

VS Code does not yet have native MCP support. This extension is a **UX layer** — it reads the stats that ashlr's MCP servers write, but it does not run the servers itself.

To use `ashlr__read`, `ashlr__edit`, and the other 15 ashlr tools:

1. Install the plugin via Claude Code or Cursor: [plugin.ashlr.ai](https://plugin.ashlr.ai)
2. Open your project in Claude Code / Cursor alongside VS Code.
3. The stats this extension displays are updated in real time as you use the tools in those hosts.

**Future plan:** a `bunx @ashlr/cli <tool> <args>` CLI is planned that will let you call any ashlr tool from a terminal or VS Code task directly. This extension will detect and surface it automatically once available.

**claude CLI detection:** if `claude` is in your PATH, the status bar tooltip shows "claude CLI detected."

---

## Links

- Plugin homepage: [plugin.ashlr.ai](https://plugin.ashlr.ai)
- Full dashboard: [plugin.ashlr.ai/dashboard](https://plugin.ashlr.ai/dashboard)
- Source: [github.com/ashlrai/ashlr-plugin](https://github.com/ashlrai/ashlr-plugin)
- Docs: [plugin.ashlr.ai/docs](https://plugin.ashlr.ai/docs)

---

## License

MIT — see [LICENSE](LICENSE).
