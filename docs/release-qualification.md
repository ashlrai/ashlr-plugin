# Release qualification

The existing release workflow reuses the canonical `ci.yml` workflow. For an immutable version tag, it reuses an eligible full manual CI run or dispatches one run on that exact tag. One global release-workflow concurrency group serializes publication across versions while main can advance. An uncertain dispatch is reconciled with reads and is never resent automatically. A failed, cancelled or incomplete full run cannot publish.

Qualification binds the canonical repository and workflow IDs, source SHA, observed tag ref, run ID and current attempt. All seven full jobs must succeed. The benchmark alone is skipped for manual CI; the daily fixup job must also complete. Linux, macOS and Windows must each provide exactly one parent `ROOT_TEST_COMPLETION` receipt matching the candidate's complete test-file inventory and platform.

The root test wrapper uses isolated workers on every platform. Before returning success it validates a fresh, child-written Bun JUnit report: every source test file is represented, nested suite and case totals agree, and failures/errors are zero. An exit-zero hook cannot replace a completed suite. Text printed by deliberately failing child fixtures is not interpreted as a parent test result. Generated docs corpus preparation still changes only the artifact excluded by `AGENTS.md`; authored freshness checks remain intact.

The qualifier has Actions write access solely to dispatch the existing CI workflow, and no OIDC authority. Publication jobs have Actions read access to recheck the same attempt immediately before GitHub release creation, each asset upload and npm publication. npm retains its existing OIDC publishing role. Signed job-log downloads never receive the GitHub credential; raw logs and test bodies are not emitted by the verifier.

The candidate and executing policy must remain ancestors of protected main. The CI and release workflows must remain active, and these five policy files must match the executing checkout, candidate and current main:

- `.github/workflows/release.yml`
- `.github/workflows/ci.yml`
- `scripts/release-ci-gate.mjs`
- `scripts/run-root-tests.ts`
- `scripts/root-test-completion.ts`

The package test command must still invoke the corrected root wrapper. App and documentation commits can advance main without changing that policy. A rerun, protection revocation, policy change or newer public stable release stops stale publication.

Use the sanctioned release workflow for an existing qualified tag, from main:

```sh
gh workflow run release.yml --repo ashlrai/ashlr-plugin --ref main -f version=X.Y.Z
```

Do not move an occupied tag, publish from the host, or reuse old binaries for a new version. A real source failure requires a checked forward repair and a fresh unused candidate. A green workflow is followed by independent registry/archive/provenance and published-asset acceptance checks.
