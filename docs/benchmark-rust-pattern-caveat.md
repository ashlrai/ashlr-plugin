# Rust match-rate caveat in the benchmark

The [`ashlr__grep` benchmark](benchmarks.md#multi-repo-reference-set) uses
the same five text-search patterns for every repository. The
[runner](../scripts/run-benchmark.ts) searches for these exact strings; four
have a trailing space:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

Rust commonly uses `fn` for functions and `use` for imports, and has `struct`,
`enum`, and `trait` rather than `class` and `interface` keywords. The fixed
patterns can therefore miss idiomatic Rust declarations. `TODO` can match
comments, and any pattern can match incidental text such as comments or
strings. Match rates depend on the repository and do not measure Rust syntax
coverage or search speed.

The runner compares plain `rg -n` output with the truncated ripgrep fallback,
not the genome-RAG path. A pattern with no output contributes no grep sample;
it is not counted as zero savings. Short outputs can require little or no
truncation. The grep mean weights each resulting pattern's token ratio
equally, so both which patterns match and the volume of their output affect
the result. If none produce a sample, the aggregate defaults to ratio 1
(0% savings); that fallback is not a measurement.

The Rust figure in the benchmark describes this fixed workload, not savings
for Rust-idiomatic searches. For a Rust-specific assessment, measure a
separate workload with representative patterns and record the repository
revision, patterns, and match and sample counts. See the
[detailed Rust guide](benchmark-rust-pattern-caveats.md) for an example and
the [methodology guide](benchmark-methodology-guide.md) for aggregation.
