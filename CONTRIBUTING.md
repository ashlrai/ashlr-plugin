# Contributing to ashlr-plugin

Thanks for considering a contribution. ashlr is small on purpose: the scope is a multi-host plugin for Claude Code and Codex that makes file tools token-efficient via [`@ashlr/core-efficiency`](https://github.com/ashlrai/ashlr-core-efficiency). Before opening a PR, skim this page.

## What belongs here

- Bug fixes with a regression test.
- Fixes, tests, and polish for the MCP tools in `servers/` (the catalog is `servers/_tool-catalog.json`).
- Genome retrieval and sync in `servers/_genome-*.ts`.
- Agents, slash commands and skills in `agents/`, `commands/` and `skills/`. Run `bun run doctor:sync` after changing skills, commands or hooks; it rewrites `.claude-plugin/install-manifest.json`.
- Documentation, including the website pages under `site/content/docs/`. Some of those pages are generated; [Edit the docs](site/README.md#edit-the-docs) lists them and their sources.
- Cross-platform fixes. Windows is the hardest CI target, and flake fixes are always welcome.
- CI fixes and benchmark harness improvements.

The optional Pro backend lives in `server/`, with its own dependencies and its own `bun run check`.

## What doesn't belong here

- Changes to the genome / compression / budgeting algorithms themselves. Those live in `@ashlr/core-efficiency`; open the PR there.
- Telemetry, analytics, or tracking that isn't strictly opt-in. Telemetry is off unless `ASHLR_TELEMETRY=on`, and the contract is [docs/telemetry.md](docs/telemetry.md).
- Tools that depend on a closed-source service without a clean local fallback.
- Anything that breaks the [privacy commitments](https://plugin.ashlr.ai/docs/pro#privacy-commitments), such as telemetry that includes paths, source, or query content.
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

You need:

- [Bun](https://bun.sh/). The required CI check pins Bun 1.4.4, so use that version or newer to match it.
- Node.js, for `bun run fresh:check` and the `ashlr-plugin` CLI.
- Git, and the [GitHub CLI](https://cli.github.com/) (`gh`) for cloning, forking, opening PRs and arming auto-merge.
- Perl 5 for the secret scan. It needs no extra modules and is preinstalled on macOS and most Linux distributions.

```bash
gh repo clone ashlrai/ashlr-plugin
cd ashlr-plugin
bun install
bun run typecheck                        # bunx tsc --noEmit
bun run test                             # plugin test suite
bun run smoke:tools                      # every default MCP tool registers (prints the count)
bun run bench -- --repo . --dry-run      # benchmark sanity, same as daily CI; writes nothing
```

Use `bun run test` for the whole suite, not plain `bun test`. The wrapper (`scripts/run-root-tests.ts`) prepares the derived docs some tests read, runs each file in isolated workers, and checks that every test file reported back. To run one file, `bun test __tests__/<name>.test.ts` is fine. [Testing](https://plugin.ashlr.ai/docs/contributing/testing) covers the other suites.

`bun run check` runs every repository check, including the `server/`, `site/` and `vscode/` checks. Those packages have their own dependencies, so install them first, as CI does:

```bash
(cd server && bun install) && (cd site && bun install) && (cd vscode && bun install)
bun run check
```

Working in a git worktree, as most agents do? Each new worktree needs its own `bun install`. Without it, tools such as `bun run smoke:tools` can fail on module errors before any test runs.

## From branch to main

People and agents take the same path.

1. **Branch or fork.** With write access, branch from `main`. Without it, fork first: `gh repo fork ashlrai/ashlr-plugin --clone`.
2. **Check locally.** Commit your work, then run `bun scripts/premerge-local.ts origin/main` (in a fork whose `main` lags, use `upstream/main`). It picks the tests your committed diff affects, runs them alongside `bun run typecheck` within a 60-second budget (`--budget-ms <n>` raises it), and prints one JSON verdict. It exits 0 on `"status":"pass"` and 1 otherwise, and it fails rather than skips when it cannot select tests. For docs-only changes, also run the doc tests listed in [AGENTS.md](AGENTS.md#work-in-this-repository).
3. **Scan for secrets.** `git diff origin/main...HEAD | perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures` runs the same scanner CI does (in a fork, diff against `upstream/main`). It prints `<blocked> allowed=<n>`, the token-shaped matches it blocked and the test-fixture placeholders it let through, and exits 1 when `<blocked>` is above zero. It never prints a value.
4. **Open a PR** using the [template](.github/PULL_REQUEST_TEMPLATE.md). Keep it to one concern and say how you tested it. If behavior changed, add a line under `## [Unreleased]` in `CHANGELOG.md`.
5. **Arm auto-merge** with `gh pr merge --auto`. That needs write access, so a maintainer arms it for a fork PR. The PR then merges through the merge queue once `CI Gate` is green, with no manual merge step.

What the pre-merge check runs depends on what your commits change. Text docs select no tests, so it runs only the typecheck: `.md`, `.mdx`, `.rst` and `.txt` files in a `docs/` folder (including `site/content/docs/`), any README, CHANGELOG, CONTRIBUTING or LICENSE file, and top-level files such as `AGENTS.md` and `llms.txt`. That is narrower than CI's docs-only list: a `meta.json` beside the site docs, any other file under `site/` or `video/`, and anything under `.github/` (the PR template included) count as config or source and run all three suites. Markdown under `commands/`, `skills/` and `agents/` is product input, not docs. A changed test file runs just that file. A change under `servers/`, `scripts/`, `hooks/`, `ports/`, `commands/`, `skills/`, `agents/` or `__tests__/` runs all three suites (`__tests__`, `server/tests` and `integration/tests`), and so does a config file (JSON, YAML, a lockfile or a dotfile) or any other source file. A change under `server/` runs `server/tests` and `integration/tests`; one under `integration/` runs only `integration/tests`. `server/` and `integration/` have their own dependencies, so for those diffs run `(cd server && bun install) && (cd integration && bun install)` first and raise the budget, for example `--budget-ms 600000`. A fail whose step note says the budget ran out means the budget was too small, not that a test failed.

`CI Gate` in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) is the single required check. On a PR it requires two jobs:

- `fast checks`: version sync, plus install, typecheck and a site release-facts check when the PR touches code. On the PR run, PRs that change only `docs/`, `site/`, `video/`, top-level Markdown, `LICENSE` or issue templates skip the install, typecheck and release-facts steps. The merge queue run always does all three, so a docs-only PR still needs a clean typecheck against the queued `main` before it lands.
- `Secret-shape scan`: the pinned scanner above, run over the PR's diff from its merge base: the added lines and the unchanged context lines around them. Removed lines are skipped, since they are already on `main`.

The rules on `main` stop there. No approving review is required, and the merge queue squash-merges each PR, so the PR title becomes the commit subject on `main`. Write it as a conventional, imperative subject such as `docs(contributing): ...` or `fix(grep): ...`. Paths listed in [`.github/CODEOWNERS`](.github/CODEOWNERS) (CI workflows, the secret-shape scanner, and files that make keyed, network or loopback requests) request the code owner's review automatically. Expect a closer look there, and keep such a change in its own PR.

To run the same checks before you push, one root `bun install` is enough; `server/`, `site/` and `vscode/` need no install for these:

```bash
bun run version:check                                    # fast checks: every manifest has the same version
bun run typecheck                                        # fast checks, code changes only
bun run site/scripts/gen-docs.ts --check --skip-corpus   # fast checks, code changes only: site release facts are fresh
git diff origin/main...HEAD | perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures   # Secret-shape scan
```

The full suite (tests, smoke, server, site and VS Code checks on Linux, plus macOS and Windows) runs daily, not per PR. Coverage, CodeQL and the benchmark also run after each merge to `main`, and none of them is a required check. A red daily run is fixed forward on `main`. Releases need their own full run; see [docs/release-qualification.md](docs/release-qualification.md).

### When a check fails

`gh pr checks <pr-number>` lists the checks on your PR (add `--watch` to wait for them). For a failed run, `gh run view <run-id> --log-failed` prints only the steps that failed. Each step `CI Gate` depends on has a local twin:

| Failed step | Run locally | Usual fix |
|---|---|---|
| `fast checks`: `Version sync check` | `bun run version:check` | The manifests disagree on the version. Only a release changes it; see [Releases](https://plugin.ashlr.ai/docs/contributing/releases). |
| `fast checks`: `Typecheck` | `bun run typecheck` | Fix the type error. |
| `fast checks`: `Site release facts` | `bun run site/scripts/gen-docs.ts --check --skip-corpus` | Run `bun run site/scripts/gen-docs.ts` and commit the files it rewrites, except `site/lib/docs.generated.json`. |
| `Secret-shape scan`: `Scan candidate diff (fail closed)` | the scan command above | Take the token-shaped string out of the diff. The scan prints counts, never the value. It reads the unchanged context lines git prints around each change as well as the added lines, so a match on an untouched line beside your edit fails too; replace that string in the same PR. A placeholder passes only in a test path (a `test/`, `tests/`, `fixtures/`, `benches/` or `examples/` folder, or a `.test.`, `.spec.` or `_test.` file) and only if it contains `FAKE`, `EXAMPLE`, `DUMMY`, `TEST` or `XXXX`. A private key block never passes. |

A PR can pass on its own and still fail in the merge queue. The queue runs the full `fast checks` against `main` plus the PRs queued ahead of it, and GitHub removes a PR whose run fails. Bring the branch up to date (`git pull origin main`, or `git pull upstream main` from a fork), fix it, and push. If `gh pr view <pr-number> --json autoMergeRequest` then shows `null`, auto-merge is off: arm it again with `gh pr merge --auto`. For a fork PR, a maintainer or fleet agent re-arms it.

## Contribute from a fork with your own agent

No write access? You can still hand the whole job to Claude Code, Codex or another coding agent. Set up the fork once:

```bash
gh repo fork ashlrai/ashlr-plugin --clone   # origin = your fork, upstream = ashlrai/ashlr-plugin
cd ashlr-plugin
bun install
git fetch upstream
git switch -c fix/<topic> upstream/main   # branch from the current upstream main
```

Then give your agent a prompt like this:

> Read AGENTS.md and the "From branch to main" section of CONTRIBUTING.md, and follow them. Fix (issue link). Keep the diff to one concern, commit, run `bun scripts/premerge-local.ts upstream/main` until it reports `"status":"pass"` (if the diff touches code, install the `server/` and `integration/` dependencies and raise `--budget-ms` first), and run the secret scan on `git diff upstream/main...HEAD`. Then push the branch to my fork and open a PR against `ashlrai/ashlr-plugin` `main` using the PR template.

The steps that differ from a maintainer branch use your fork and its `upstream` remote:

```bash
git diff upstream/main...HEAD | perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures   # scan against the PR's real base
git push -u origin fix/<topic>   # push to your fork
gh pr create --repo ashlrai/ashlr-plugin --base main --head <your-github-user>:fix/<topic> --fill
```

After that:

- `CI Gate` runs on the PR. For a docs-only change (`docs/`, `site/`, `video/`, top-level Markdown, `LICENSE` or issue templates), the PR run of `fast checks` skips the install, typecheck and release-facts steps, so it is mostly version sync and the secret scan. The merge queue run always does the full `fast checks`. GitHub can hold workflow runs from a first-time contributor until a maintainer approves them.
- You cannot arm auto-merge on a fork PR. A maintainer or fleet agent arms it, and the PR lands through the merge queue once `CI Gate` is green.
- In a fork, `origin/main` is your fork's `main`, which stops moving once you fork. CI compares the PR against `ashlrai/ashlr-plugin` `main`, so local checks use `upstream/main` too.
- If `main` moved on, run `git pull upstream main` on your branch and push again.

## PR checklist

The [PR template](.github/PULL_REQUEST_TEMPLATE.md) asks for most of these too, so people and agents tick the same boxes.

- [ ] `bun scripts/premerge-local.ts origin/main` (`upstream/main` from a fork) reports `"status":"pass"`. It covers `bun run typecheck` and the tests your diff affects. For a docs-only change, the doc tests in [AGENTS.md](AGENTS.md#work-in-this-repository) pass too.
- [ ] The secret scan is clean: `git diff origin/main...HEAD | perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures` (`upstream/main...HEAD` from a fork)
- [ ] If you changed a tool's output: the `RESULT` line of `bun run bench -- --repo . --dry-run` doesn't drop by more than 5 points against `main`
- [ ] `bun run smoke:tools` still reports all 54 MCP tools
- [ ] If you added a tool or changed a tool's name, description or input schema: run `bun run references:sync`. It regenerates `servers/_tool-catalog.json` (the router lists only catalog tools), the tool counts in the docs, and the generated site tool pages. A new doc that quotes the current count goes in `countFiles` in `scripts/sync-tool-counts.ts`. `bun run references:check` checks for drift.
- [ ] If you changed skills, commands or hooks: run `bun run doctor:sync` and commit the rewritten `.claude-plugin/install-manifest.json`
- [ ] If you touched a manifest: `bun run version:check` passes
- [ ] If behavior changed: `CHANGELOG.md` has a line under `## [Unreleased]`
- [ ] No new network calls or telemetry without an opt-in
- [ ] If you changed the website (`site/`): `cd site && bun install && bun run check` passes
- [ ] Hot files left alone: new pipe server cases are in a new `__tests__/pipe-server-<topic>.test.ts`, and `site/lib/docs.generated.json` is not in the commit
- [ ] The PR title is a conventional, imperative subject (it becomes the squashed commit on `main`), and the description says *why*, not just *what*

## Style

TypeScript strict, two-space indent, explicit return types on exported APIs. Prefer named exports over default. No classes unless state genuinely belongs together. We don't ship a prettier/biome config in this repo by design — the sibling [ashlr-core-efficiency](https://github.com/ashlrai/ashlr-core-efficiency) is the reference for what clean looks like.

## License

MIT. By submitting a PR, you agree your contribution is licensed under the same terms as the project.

## DeepWiki outline

[`.devin/wiki.json`](.devin/wiki.json) gives DeepWiki repository context and an explicit page outline for generated documentation. Keep `repo_notes` grounded in the source and public docs, and update the `pages` titles and purposes when major subsystems or their locations change. The listed pages define the intended coverage; review generated material against the code and maintained documentation. See the [DeepWiki configuration guide](https://docs.devin.ai/work-with-devin/deepwiki) for the format and generation workflow.
