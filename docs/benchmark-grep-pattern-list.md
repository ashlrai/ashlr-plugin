# Benchmark grep pattern list

The `ashlr__grep` workload in the [benchmark runner](../scripts/run-benchmark.ts)
uses these five search strings in source order:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

The space at the end of each string except `TODO` is part of the search
pattern. The runner compares plain `rg -n` output with the no-genome
`ashlr__grep` ripgrep fallback. A pattern that produces no output contributes
no sample to the grep mean. This fixed workload is not a measure of language
coverage or search recall; see [interpreting benchmark grep results](benchmark-grep-interpretation.md)
for details.

Run the benchmark without writing results from the repository root:

```sh
bun run scripts/run-benchmark.ts --dry-run
```
