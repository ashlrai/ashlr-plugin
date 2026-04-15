# Contributing to ashlr-plugin

Thanks for considering a contribution. ashlr is small on purpose — the scope is a Claude Code plugin that makes file tools token-efficient via [`@ashlr/core-efficiency`](https://github.com/masonwyatt23/ashlr-core-efficiency). Before opening a PR, skim this page.

## What belongs here

- Fixes, tests, and polish for the three MCP tools (`ashlr__read`, `ashlr__grep`, `ashlr__edit`)
- Improvements to the agent definitions in `agents/` (delegation rules, prompt clarity)
- Slash command improvements in `commands/`
- CI fixes, landing page refinements, benchmark harness improvements

## What doesn't belong here

- Changes to the genome / compression / budgeting algorithms themselves — those live in `@ashlr/core-efficiency`. Open the PR there.
- Paid / closed features, telemetry, or any analytics pipeline that phones home
- Bundled third-party code that requires us to ship binaries

## Dev loop

```bash
gh repo clone masonwyatt23/ashlr-plugin
cd ashlr-plugin
bun install
bunx tsc --noEmit            # typecheck
bun run servers/bench.ts     # benchmark sanity

# Smoke test the MCP server
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dev","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | bun run servers/efficiency-server.ts
```

## PR checklist

- [ ] `bunx tsc --noEmit` passes
- [ ] Benchmark doesn't regress savings % by more than 5 points
- [ ] MCP smoke test still reports all 4 tools
- [ ] If you changed the landing page: it still loads at HTTP 200 from a local `bun` static server, and the OG image is intact
- [ ] Commit messages are imperative-mood and say *why*, not just *what*

## Style

TypeScript strict, two-space indent, explicit return types on exported APIs. Prefer named exports over default. No classes unless state genuinely belongs together. We don't ship a prettier/biome config in this repo by design — the sibling [ashlr-core-efficiency](https://github.com/masonwyatt23/ashlr-core-efficiency) is the reference for what clean looks like.

## License

MIT. By submitting a PR, you agree your contribution is licensed under the same terms as the project.
