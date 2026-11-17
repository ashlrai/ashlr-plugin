# Investigation notes

- Checkout: 2c76b4ac7d72e18466b09d8becd174c37eb8d532, merged guardian PR #1191.
- Guardian source commit 8062f628 restores docs/benchmarks-v2.json, moves weekly
  self-repository output to docs/benchmarks-self.json, and adds the regression test
  __tests__/ci-weekly-benchmark-output.test.ts.
- Root cause: self-repository output replaced the canonical multi-repository JSON,
  losing cross-language fields and disagreeing with the public site snapshot.
- Existing PR #1192's local branch is codex-bridge/FIXUP-CI-ashlr-plugin-ci-064694,
  commit 403b483bc07e9c7d81c5ce723c6bd522efb9ec39. It references failing main run
  43944064694, moves output to RUNNER_TEMP, removes automatic refresh PR creation,
  and reduces the benchmark job permissions to contents: read.
- #1192 was based on an older main: its direct diff against this checkout lacks
  #1191's regression test. This is branch divergence, not a test deletion in its
  own commit. No changes from either guardian were copied here.
- Locus denied live PR/run reads. No alternative identity or direct gh access used.
- Local Bun is 1.3.14; workflow pin is 1.4.4. No Linux or remote CI claim is made.
- Targeted tests: 39 pass / 0 fail; expanded affected suite: 206 pass / 0 fail.
- Typecheck passes; mdx-lint passes with 89 files scanned.
