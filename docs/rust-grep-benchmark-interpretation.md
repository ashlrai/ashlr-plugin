# Interpreting the Rust grep benchmark

The [benchmark runner](../scripts/run-benchmark.ts) uses the same five text
patterns for every repository. Each string except `TODO` ends in a space:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

These patterns are not tailored to Rust: functions use `fn`, imports commonly
use `use`, and Rust uses `struct`, `enum`, and `trait` instead of `class` or
`interface`. The non-Rust keywords can still appear in comments, strings, or
other text; `TODO` can match comments and its frequency varies by repository.
Thus the patterns may have low match rates without saying how well grep finds
idiomatic Rust code. A search such as `rg -n 'use ' <repo>` is an illustrative
Rust-oriented alternative, not part of the measured workload.

The runner compares estimated output tokens from plain `rg -n` with the
no-genome grep fallback. Short results can leave little output to truncate,
reducing measured savings. A pattern with no output contributes no grep
sample, not a zero-savings sample; the grep mean equally weights the remaining
sample ratios. If there are no samples, ratio 1 (0% savings) is a fallback,
not a measurement. The number of grep samples also changes their weight in
the overall mean, which pools read, grep, and synthetic edit samples.

The [reported Rust result](benchmarks.md#multi-repo-reference-set) describes
this fixed workload on the sampled Tokio files, not expected savings for
Rust-idiomatic searches or search speed. The saved reference-repository data
contains aggregates, not individual Rust grep samples or match counts, so it
does not establish which patterns matched or why results differ between repos.
Compare a representative Rust-specific workload separately, recording the
revision, patterns, match counts, and sample counts; measure timing separately
if speed is the question.
