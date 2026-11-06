# Purpose of the benchmark grep patterns

The [benchmark runner](../scripts/run-benchmark.ts) searches every target
repository with the same five patterns, in this order:

| Search string | Role in the workload |
| --- | --- |
| `function ` | Samples searches for JavaScript and TypeScript function declarations. |
| `import ` | Samples searches for import statements common in TypeScript and Python. |
| `TODO` | Samples a cross-language convention for notes about unfinished work. |
| `class ` | Samples searches for class declarations common in TypeScript and Python. |
| `interface ` | Samples searches for TypeScript interface declarations. |

The trailing space is part of every pattern except `TODO`. These are ripgrep
text searches, not syntax-aware queries: they can match comments, strings, or
other incidental text. They are a small, repeatable workload, not a complete
or representative inventory of every language's constructs. In particular,
Rust commonly uses `fn`, `use`, `struct`, `enum`, and `trait` instead of the
declaration keywords above.

For each pattern with output, the runner compares plain `rg -n` output with
the truncated ripgrep fallback used by `ashlr__grep`. Each resulting token
ratio has equal weight in the grep mean; patterns with no output contribute no
sample. If none produces output, the grep aggregate defaults to a ratio of 1,
which is a fallback rather than a measurement. Different match volumes and
missing samples therefore affect comparisons between repositories. The
benchmark measures output-size savings, not search speed, language coverage,
or total session savings. See [the benchmark results and methodology](benchmarks.md)
for the reference results and aggregation details.
