# Benchmark grep pattern inventory

Which grep patterns does the benchmark use, and do the runner and the published
results agree? Yes, they agree. There are no differences.

Sources compared:

- Runner: `GREP_PATTERNS` in [`scripts/run-benchmark.ts`](../scripts/run-benchmark.ts)
- Results: `samples.ashlr__grep[].pattern` in [`benchmarks-v2.json`](benchmarks-v2.json)

| # | Pattern (quoted) | In runner | In `benchmarks-v2.json` | Notes |
|---|------------------|-----------|-------------------------|-------|
| 1 | `"function "`  | yes | yes | trailing space is part of the pattern |
| 2 | `"import "`    | yes | yes | trailing space is part of the pattern |
| 3 | `"TODO"`       | yes | yes | no trailing space |
| 4 | `"class "`     | yes | yes | trailing space is part of the pattern |
| 5 | `"interface "` | yes | yes | trailing space is part of the pattern |

## Differences

- Only in the runner: none.
- Only in `benchmarks-v2.json`: none.
- Order: identical (runner source order equals sample order).
- Whitespace: identical. Trailing spaces are significant and match exactly.

A pattern with no matches in the measured repo is skipped, not scored as zero.
So the results file could in future hold fewer patterns than the runner. That
is a gap in the data, not a mismatch in configuration.

## Check it

`__tests__/benchmark-grep-inventory.test.ts` fails if either source drifts from
this table, or if the two sources differ in set or order. Run it with:

```sh
bun test __tests__/benchmark-grep-inventory.test.ts
```

Related: [pattern list](benchmark-grep-pattern-list.md),
[interpreting grep results](benchmark-grep-interpretation.md).
