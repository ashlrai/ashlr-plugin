# Benchmark grep patterns

The `ashlr__grep` workload in the [benchmark runner](../scripts/run-benchmark.ts)
uses these five common benchmark queries, in this order:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

The trailing space is part of each query except `TODO`. These fixed
code-search idioms make runs comparable; they are a workload sample, not a
measure of language coverage or search recall. For example, Rust commonly uses
`fn` and `use` instead of `function ` and `import `.

For each pattern, the runner compares plain `rg -n` output with the
no-genome `ashlr__grep` ripgrep fallback. Patterns with no output contribute
no sample to the grep mean, so the mean describes only patterns that produced
output. See the [benchmark methodology guide](benchmark-methodology-guide.md)
for aggregation and interpretation details.

Run against the current repository without writing a result file:

```sh
bun run scripts/run-benchmark.ts --dry-run
```

Pass `--repo /path/to/repo` to measure another repository.
