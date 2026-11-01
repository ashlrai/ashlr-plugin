# Interpreting benchmark grep results

The [token-savings benchmark](benchmarks.md) compares output sizes for one
fixed grep workload across repositories. The [runner](../scripts/run-benchmark.ts)
compares plain `rg -n` output with the no-genome ripgrep fallback; it does not
measure search speed, language coverage, or savings across a whole session.

## Fixed workload

Every repository gets these five searches, in order. The trailing space in
each string other than `TODO` is part of the pattern:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

These are text searches, not syntax-aware queries: they can match comments or
strings as well as code. The spaces affect which text matches.

## Why Rust can match less often

Rust normally uses `fn` for functions and `use` for imports, and has `struct`,
`enum`, and `trait` constructs instead of `class` and `interface` keywords.
The corresponding benchmark patterns may therefore miss Rust declarations or
match incidental text instead. `TODO` can appear in Rust comments, but its
frequency depends on the repository. For example, `rg -n 'use ' <repo>` is a
Rust-oriented illustrative search, not one of the five measured patterns or a
complete search for imports.

The [saved data](benchmarks-v2.json) retains reference-repo aggregates, not
individual Rust grep samples or match counts. It cannot establish which
patterns matched Tokio or prove why its result differs from another repo.

## Reading the numbers

For each pattern producing output, the runner records bytes and estimated
tokens for the raw and fallback outputs. Its ratio is fallback estimated
tokens divided by raw estimated tokens; savings are `(1 - ratio) × 100%`.
The fallback limits long lines and, above 4,000 characters, retains whole
lines from the head and tail with an omission notice. Few matches can produce
short output with little or no savings, though line length also matters.

A search with no output contributes no sample, rather than a zero-savings
sample. The grep mean weights each remaining pattern ratio equally; if none
produce a sample, the aggregate defaults to ratio 1 (0% savings), a fallback
rather than a measurement. The overall mean pools individual read, grep, and
edit samples, so fewer grep samples also change grep's weight in that mean.

Compare results with the exact patterns and sample counts in mind. To assess
Rust-idiomatic searches, run representative patterns separately, record the
repository revision and match counts, and report their results separately from
the fixed workload. Use a separate timing experiment to assess speed. See the
[pattern selection guide](benchmark-pattern-selection.md) for the recorded
reference figures and further limitations.
