# ashlr for VS Code

This extension shows the savings that [ashlr-plugin](https://github.com/ashlrai/ashlr-plugin) records. ashlr-plugin is an open-source efficiency layer for coding agents. Its `ashlr-mcp` server gives Claude Code, Codex, Cursor and other MCP hosts shorter file, search, edit and shell results, and writes what each call saved to a local ledger, `~/.ashlr/stats.json`.

The extension only reads that ledger. It does not run the MCP server or any ashlr tool, and it makes no network requests. Measured per-call savings are in [docs/benchmarks.md](https://github.com/ashlrai/ashlr-plugin/blob/main/docs/benchmarks.md).

> No ledger yet? Install the plugin first: see [Install](https://github.com/ashlrai/ashlr-plugin#install) in the main README, or [plugin.ashlr.ai](https://plugin.ashlr.ai). The same numbers are available in a terminal with `ashlr-plugin stats --json`.

---

## Features

- **Status bar.** `ashlr · session +12.4k · lifetime +840k` in the bottom-right corner, refreshed every `ashlr.pollIntervalMs` (2 seconds by default). It shows `ashlr · not running` when there is no `stats.json`. Click it to open the dashboard.
- **Dashboard webview.** Session, lifetime and best-day tiles, a per-tool bar chart, 7-day and 30-day sparklines, and projected annual savings.
- **Gutter badges.** A savings hint after lines in the active editor that mention `ashlr__read`, `ashlr__edit`, `ashlr__grep`, `Read(` or `Edit(`. The badge is a rough estimate (55% of the referenced file's size at about 4 bytes per token, or a fixed 500 tokens when no path is found), not a measured number.
- **Commands.** Five palette commands, listed below.

---

## Commands

| Command | Description |
|---------|-------------|
| `ashlr: Show Dashboard` | Opens the savings dashboard webview. |
| `ashlr: Open Genome Folder` | Reveals `.ashlrcode/genome/` in the Explorer, offering to create it if absent. |
| `ashlr: Run Benchmark` | Runs `scripts/run-benchmark.ts` in a new terminal. Works only when an ashlr-plugin checkout is the workspace. |
| `ashlr: Show Savings` | Shows a plain-text savings summary and whether the `claude` CLI is on `PATH`. |
| `ashlr: Sign in to Pro` | Opens [plugin.ashlr.ai/signin](https://plugin.ashlr.ai/signin) in your browser. |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `ashlr.statsPath` | `""` | Path to `stats.json`. Leave empty to use `~/.ashlr/stats.json`. |
| `ashlr.pollIntervalMs` | `2000` | How often (ms) the status bar polls `stats.json`. |
| `ashlr.showGutterBadges` | `true` | Show the estimated savings badges in the editor. |

---

## Install

Each [GitHub release](https://github.com/ashlrai/ashlr-plugin/releases) attaches the packaged extension as `ashlr-X.Y.Z.vsix` when packaging succeeds. Install it with:

```bash
code --install-extension ashlr-X.Y.Z.vsix
```

---

## Build from source

The extension lives in `vscode/` of the ashlr-plugin repository and has its own dependencies.

```bash
cd vscode
bun install
bun run check     # typecheck, then build out/extension.js
bun run watch     # rebuild on change
bun run package   # write a .vsix with vsce
```

To try a build, open `vscode/` in VS Code and start the Extension Development Host (Run > Start Debugging). [test-manual.md](test-manual.md) is the manual QA checklist.

The root `bun run check` includes this package's check, and the daily CI run builds it. Changes here take the same path to `main` as the rest of the repository; see [CONTRIBUTING.md](../CONTRIBUTING.md#from-branch-to-main). Coding agents work on it under [AGENTS.md](../AGENTS.md), as they do across the [Ashlr ecosystem](../README.md#part-of-the-ashlr-ecosystem).

---

## Links

- Source: [github.com/ashlrai/ashlr-plugin](https://github.com/ashlrai/ashlr-plugin)
- Docs: [plugin.ashlr.ai/docs](https://plugin.ashlr.ai/docs)
- Web dashboard (sign-in required): [plugin.ashlr.ai/dashboard](https://plugin.ashlr.ai/dashboard)

---

## License

MIT. See [LICENSE](LICENSE).
