<!--
People and agents use the same template. The full path from branch to main
is in CONTRIBUTING.md ("From branch to main"). Keep the PR to one concern.
-->

## What this changes

<!-- One or two sentences. Link the issue: "Closes #123". -->

## Why

## How I tested it

- [ ] `bun scripts/premerge-local.ts origin/main` (`upstream/main` from a fork) reports `"status":"pass"` (typecheck plus the tests this diff affects)
- [ ] `bun run typecheck`
- [ ] `bun run test` (or the specific `__tests__/…` files touched)
- [ ] Docs-only change: `bun test __tests__/readme-links.test.ts __tests__/readme-commands-samples.test.ts __tests__/agent-front-door.test.ts`
- [ ] Changed `CONTRIBUTING.md`, `AGENTS.md`, this template or `site/content/docs/contributing/`: `bun test __tests__/contributing-check-failures.test.ts __tests__/contributing-fork-path.test.ts __tests__/contributing-merge-rules.test.ts __tests__/contributing-pr-checklist.test.ts __tests__/contributing-scope-parity.test.ts __tests__/pr-template-commands.test.ts __tests__/hot-file-rule.test.ts`
- [ ] Manually exercised the tool/hook/command in a host (say which one)

## Checklist

- [ ] Secret scan is clean: `git diff origin/main...HEAD | perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures` (`upstream/main...HEAD` from a fork)
- [ ] Added a tool or changed a tool's name, description or input schema: ran `bun run references:sync` (catalog, tool counts, site tool pages), and `bun run references:check` reports nothing but the expected `site/lib/docs.generated.json is stale` line
- [ ] Changed skills, commands or hooks: ran `bun run doctor:sync` and committed the rewritten `.claude-plugin/install-manifest.json`
- [ ] `bun run version:check` passes if you touched a manifest
- [ ] `CHANGELOG.md` updated under **Unreleased** if behavior changed
- [ ] No new network calls or telemetry without an opt-in
- [ ] Hot files left alone: new pipe server cases are in a new `__tests__/pipe-server-<topic>.test.ts`, and `site/lib/docs.generated.json` is not committed
- [ ] No agent scratch files in the commit: planning notes, investigation logs or evidence patches stay out of the repository, and this description carries what reviewers need
- [ ] The PR title is a conventional, imperative subject such as `docs(contributing): ...` or `fix(grep): ...`; the merge queue squash-merges, so it becomes the commit subject on `main`

<!--
Merging: `CI Gate` is the only required check (fast checks plus the secret
scan). Arm auto-merge with `gh pr merge --auto`; a maintainer arms it for fork
PRs. The PR then lands through the merge queue with no manual merge step.
-->
