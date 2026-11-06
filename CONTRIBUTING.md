# Contributing to ashlr-plugin

Thanks for considering a contribution. ashlr is small on purpose — the scope is a Claude Code plugin that makes file tools token-efficient via [`@ashlr/core-efficiency`](https://github.com/ashlrai/ashlr-core-efficiency). Before opening a PR, skim this page.

## What belongs here

- Fixes, tests, and polish for the three MCP tools (`ashlr__read`, `ashlr__grep`, `ashlr__edit`)
- Improvements to the agent definitions in `agents/` (delegation rules, prompt clarity)
- Slash command improvements in `commands/`
- CI fixes, landing page refinements, benchmark harness improvements

## What doesn't belong here

- Changes to the genome / compression / budgeting algorithms themselves — those live in `@ashlr/core-efficiency`. Open the PR there.
- Paid / closed features, telemetry, or any analytics pipeline that phones home
- Bundled third-party code that requires us to ship binaries

## Finding something to work on

New here? Start with the [good first issue](https://github.com/ashlrai/ashlr-plugin/labels/good%20first%20issue) label. Issues also labeled [help wanted](https://github.com/ashlrai/ashlr-plugin/labels/help%20wanted) are ones we would especially like a PR for.

- Comment on the issue before you start so two people do not do the same work.
- Keep the PR small and tied to one issue. Say in the description how you tested it.
- If you are unsure whether something belongs here, open an issue first and ask.
- Questions are welcome in issues. We read all of them.

## Dev loop

```bash
gh repo clone ashlrai/ashlr-plugin
cd ashlr-plugin
bun install
bunx tsc --noEmit            # typecheck
bun run test                 # test suite
bun run check                # full repository checks
bun run servers/bench.ts     # benchmark sanity

# Smoke test the MCP router: every tool registers (prints the count)
bun run smoke:tools
```

## PR checklist

- [ ] `bunx tsc --noEmit` passes
- [ ] Benchmark doesn't regress savings % by more than 5 points
- [ ] `bun run smoke:tools` still reports all 54 MCP tools
- [ ] Run `bun run tool-counts:sync` after catalog changes; add new current-count copy to the inventory in `scripts/sync-tool-counts.ts`. `bun run tool-counts:check` checks for drift.
- [ ] If you changed the landing page: it still loads at HTTP 200 from a local `bun` static server, and the OG image is intact
- [ ] Commit messages are imperative-mood and say *why*, not just *what*

## Style

TypeScript strict, two-space indent, explicit return types on exported APIs. Prefer named exports over default. No classes unless state genuinely belongs together. We don't ship a prettier/biome config in this repo by design — the sibling [ashlr-core-efficiency](https://github.com/ashlrai/ashlr-core-efficiency) is the reference for what clean looks like.

## License

MIT. By submitting a PR, you agree your contribution is licensed under the same terms as the project.
