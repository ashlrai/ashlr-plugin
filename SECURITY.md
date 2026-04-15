# Security Policy

## Reporting

If you've found a vulnerability in ashlr-plugin or `@ashlr/core-efficiency`, please email **masonwyatt23@users.noreply.github.com** with details. Do not open a public GitHub issue for vulnerabilities.

Expect a reply within 72 hours.

## Scope

In scope:
- The MCP server (`servers/efficiency-server.ts`) — path traversal, unsafe shell invocation, code execution via crafted arguments, stats-file poisoning
- The shared `@ashlr/core-efficiency` library — the same categories, plus crafted genome manifests that could escape the genome directory
- The agent definitions in `agents/*.md` — prompt-injection shapes that would cause the agent to take actions against the user's interest

Not in scope:
- Claude Code itself (report to Anthropic)
- The GitHub Pages hosting layer (report to GitHub)
- The dependencies we pull from npm — if it's in `node_modules`, start with the upstream project. We'll coordinate if it affects ashlr directly.

## Defaults

- The MCP server binds to stdio only — no network socket is opened.
- Savings stats are written to `~/.ashlr/stats.json` with user-readable permissions (no secrets stored).
- No telemetry. No phone-home. No analytics beacon.

## Acknowledgements

We keep a simple thank-you list in release notes for researchers who report responsibly.
