<!--
People and agents use the same template. The full path from branch to main
is in CONTRIBUTING.md ("From branch to main"). Keep the PR to one concern.
-->

## What this changes

<!-- One or two sentences. Link the issue: "Closes #123". -->

## Why

## How I tested it

- [ ] `bun scripts/premerge-local.ts origin/main` reports `"status":"pass"` (typecheck plus the tests this diff affects)
- [ ] `bun run typecheck`
- [ ] `bun run test` (or the specific `__tests__/…` files touched)
- [ ] Docs-only change: `bun test __tests__/readme-links.test.ts __tests__/readme-commands-samples.test.ts __tests__/agent-front-door.test.ts`
- [ ] Manually exercised the tool/hook/command in a host (say which one)

## Checklist

- [ ] Secret scan is clean: `git diff origin/main...HEAD | perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures`
- [ ] If tools, commands, or skills changed, the counts in README/docs still match (`bun run tool-counts:check`)
- [ ] `bun run version:check` passes if you touched a manifest
- [ ] `CHANGELOG.md` updated under **Unreleased** if behavior changed
- [ ] No new network calls or telemetry without an opt-in
- [ ] Hot files left alone: new pipe server cases are in a new `__tests__/pipe-server-<topic>.test.ts`, and `site/lib/docs.generated.json` is not committed

<!--
Merging: `CI Gate` is the only required check (fast checks plus the secret
scan). Arm auto-merge with `gh pr merge --auto`; a maintainer arms it for fork
PRs. The PR then lands through the merge queue with no manual merge step.
-->
