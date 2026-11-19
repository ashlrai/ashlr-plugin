# Contributing to ashlr-plugin

Thanks for considering a contribution. ashlr is small on purpose: the scope is a multi-host plugin for Claude Code and Codex that makes file tools token-efficient via [`@ashlr/core-efficiency`](https://github.com/ashlrai/ashlr-core-efficiency). Before opening a PR, skim this page.

## What belongs here

- Bug fixes with a regression test.
- Fixes, tests, and polish for the MCP tools in `servers/` (the catalog is `servers/_tool-catalog.json`).
- Genome retrieval and sync in `servers/_genome-*.ts`.
- Agents, slash commands and skills in `agents/`, `commands/` and `skills/`. Run `bun run doctor:sync` after changing skills, commands or hooks; it rewrites `.claude-plugin/install-manifest.json`.
- Documentation, including the website pages under `site/content/docs/`.
- Cross-platform fixes. Windows is the hardest CI target, and flake fixes are always welcome.
- CI fixes and benchmark harness improvements.

The optional Pro backend lives in `server/`, with its own dependencies and its own `bun run check`.

## What doesn't belong here

- Changes to the genome / compression / budgeting algorithms themselves. Those live in `@ashlr/core-efficiency`; open the PR there.
- Telemetry, analytics, or tracking that isn't strictly opt-in. Telemetry is off unless `ASHLR_TELEMETRY=on`, and the contract is [docs/telemetry.md](docs/telemetry.md).
- Tools that depend on a closed-source service without a clean local fallback.
- Bundled third-party code that requires us to ship binaries.

## Finding something to work on

New here? Start with the [good first issue](https://github.com/ashlrai/ashlr-plugin/labels/good%20first%20issue) label. Issues also labeled [help wanted](https://github.com/ashlrai/ashlr-plugin/labels/help%20wanted) are ones we would especially like a PR for.

- Comment on the issue before you start so two people do not do the same work.
- Keep the PR small and tied to one issue. Say in the description how you tested it.
- If you are unsure whether something belongs here, open an issue first and ask.
- Questions are welcome in issues. We read all of them.

## Agents work here too

ashlr-plugin is part of the [Ashlr ecosystem](README.md#part-of-the-ashlr-ecosystem). [Phantom](https://github.com/ashlrai/phantom) and its sibling repos form an autonomous, code-first, agent-native software factory: agents do the engineering, the human sits as a passive board member, and the goal is open source RSI (recursive self-improvement). Most PRs here are opened by coding agents, and they follow the same rules as people.

Agents start with [AGENTS.md](AGENTS.md). It sets what agents may do (branch, commit, open PRs, merge on green), the kept limits, and two hot-file rules that keep parallel PRs from colliding:

- New pipe server cases go in a new test file such as `__tests__/pipe-server-<topic>.test.ts`, not in `__tests__/pipe-server.test.ts`.
- Do not commit a regenerated `site/lib/docs.generated.json`.

Agents are also users of the plugin. [llms.txt](llms.txt) is the index and [llms-full.txt](llms-full.txt) has the install, the `--json` CLI, and MCP snippets for each host.

## Dev loop

```bash
gh repo clone ashlrai/ashlr-plugin
cd ashlr-plugin
bun install
bun run typecheck                        # bunx tsc --noEmit
bun run test                             # plugin test suite
bun run smoke:tools                      # every MCP tool registers (prints the count)
bun run bench -- --repo . --dry-run      # benchmark sanity, same as daily CI; writes nothing
```

`bun run check` runs every repository check, including the `server/`, `site/` and `vscode/` checks. Those packages have their own dependencies, so install them first, as CI does:

```bash
(cd server && bun install) && (cd site && bun install) && (cd vscode && bun install)
bun run check
```

Working in a git worktree, as most agents do? Each new worktree needs its own `bun install`. Without it, tools such as `bun run smoke:tools` can fail on module errors before any test runs.

## From branch to main

People and agents take the same path.

1. **Branch or fork.** With write access, branch from `main`. Without it, fork first: `gh repo fork ashlrai/ashlr-plugin --clone`.
2. **Check locally.** Run `bun run typecheck` and the tests you touched (`bun test __tests__/<file>.test.ts`). For docs-only changes, run the doc tests listed in [AGENTS.md](AGENTS.md#work-in-this-repository).
3. **Scan for secrets.** `git diff origin/main...HEAD | perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures` runs the same scanner CI does. It prints a count and exits 1 on a match, never the value.
4. **Open a PR** using the [template](.github/PULL_REQUEST_TEMPLATE.md). Keep it to one concern and say how you tested it. If behavior changed, add a line under `## [Unreleased]` in `CHANGELOG.md`.
5. **Arm auto-merge** with `gh pr merge --auto`. That needs write access, so a maintainer arms it for a fork PR. The PR then merges through the merge queue once `CI Gate` is green, with no manual merge step.

`CI Gate` in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) is the single required check. On a PR it requires two jobs:

- `fast checks`: version sync, plus install, typecheck and a site release-facts check when the PR touches code. PRs that change only `docs/`, `site/`, `video/`, top-level Markdown, `LICENSE` or issue templates skip the install and typecheck steps.
- `Secret-shape scan`: the pinned scanner above, run over the lines the PR adds.

The rules on `main` stop there. No approving review is required, and the merge queue squash-merges each PR, so the PR title becomes the commit subject on `main`. Write it as a conventional, imperative subject such as `docs(contributing): ...` or `fix(grep): ...`. Paths listed in [`.github/CODEOWNERS`](.github/CODEOWNERS) (CI workflows, the secret-shape scanner, and files that make keyed, network or loopback requests) request the code owner's review automatically. Expect a closer look there, and keep such a change in its own PR.

To run the same checks before you push, one root `bun install` is enough; `server/`, `site/` and `vscode/` need no install for these:

```bash
bun run version:check                                    # fast checks: every manifest has the same version
bun run typecheck                                        # fast checks, code changes only
bun run site/scripts/gen-docs.ts --check --skip-corpus   # fast checks, code changes only: site release facts are fresh
git diff origin/main...HEAD | perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures   # Secret-shape scan
```

If the release-facts check reports a stale file after a version, tool or command change, run `bun run site/scripts/gen-docs.ts` and commit the files it rewrites, except `site/lib/docs.generated.json`.

The full suite (tests, smoke, server, site and VS Code checks on Linux, plus macOS and Windows) runs daily, not per PR. Coverage, CodeQL and the benchmark also run after each merge to `main`, and none of them is a required check. A red daily run is fixed forward on `main`. Releases need their own full run; see [docs/release-qualification.md](docs/release-qualification.md).

## Contribute from a fork with your own agent

No write access? You can still hand the whole job to Claude Code, Codex or another coding agent. Set up the fork once:

```bash
gh repo fork ashlrai/ashlr-plugin --clone   # origin = your fork, upstream = ashlrai/ashlr-plugin
cd ashlr-plugin
bun install
git switch -c fix/<topic>
```

Then give your agent a prompt like this:

> Read AGENTS.md and the "From branch to main" section of CONTRIBUTING.md, and follow them. Fix (issue link). Keep the diff to one concern, run `bun run typecheck` plus the tests you touched, and run the secret scan on the diff. Then push the branch to my fork and open a PR against `ashlrai/ashlr-plugin` `main` using the PR template.

The two steps that differ from a maintainer branch:

```bash
git push -u origin fix/<topic>   # push to your fork
gh pr create --repo ashlrai/ashlr-plugin --base main --head <your-github-user>:fix/<topic> --fill
```

After that:

- `CI Gate` runs on the PR. For a docs-only change (`docs/`, `site/`, `video/`, top-level Markdown), `fast checks` skips the install and typecheck, so the gate is mostly version sync and the secret scan. GitHub can hold workflow runs from a first-time contributor until a maintainer approves them.
- You cannot arm auto-merge on a fork PR. A maintainer or fleet agent arms it, and the PR lands through the merge queue once `CI Gate` is green.
- If `main` moved on, run `git pull upstream main` on your branch and push again.

## PR checklist

- [ ] `bun run typecheck` passes
- [ ] If you changed a tool's output: the `RESULT` line of `bun run bench -- --repo . --dry-run` doesn't drop by more than 5 points against `main`
- [ ] `bun run smoke:tools` still reports all 54 MCP tools
- [ ] Run `bun run tool-counts:sync` after catalog changes; add new current-count copy to the inventory in `scripts/sync-tool-counts.ts`. `bun run tool-counts:check` checks for drift.
- [ ] If you changed the website (`site/`): `cd site && bun install && bun run check` passes, and `site/lib/docs.generated.json` is not in the commit
- [ ] The PR title is a conventional, imperative subject (it becomes the squashed commit on `main`), and the description says *why*, not just *what*

## Style

TypeScript strict, two-space indent, explicit return types on exported APIs. Prefer named exports over default. No classes unless state genuinely belongs together. We don't ship a prettier/biome config in this repo by design — the sibling [ashlr-core-efficiency](https://github.com/ashlrai/ashlr-core-efficiency) is the reference for what clean looks like.

## License

MIT. By submitting a PR, you agree your contribution is licensed under the same terms as the project.

## DeepWiki outline

[`.devin/wiki.json`](.devin/wiki.json) gives DeepWiki repository context and an explicit page outline for generated documentation. Keep `repo_notes` grounded in the source and public docs, and update the `pages` titles and purposes when major subsystems or their locations change. The listed pages define the intended coverage; review generated material against the code and maintained documentation. See the [DeepWiki configuration guide](https://docs.devin.ai/work-with-devin/deepwiki) for the format and generation workflow.
