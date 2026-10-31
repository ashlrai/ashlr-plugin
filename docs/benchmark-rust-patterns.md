# Rust patterns in the token-savings benchmark

The [benchmark](benchmarks.md) uses the same five grep patterns for every
reference repo. This fixed workload makes runs comparable, but several patterns
do not represent common Rust syntax. The reported Rust grep savings therefore
describe these searches in the sampled Tokio files, not Rust searches in general.

## The fixed workload

Four strings include a trailing space:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

| Sample pattern | Limitation for Rust |
| --- | --- |
| `function ` | Rust declares functions with `fn`; this can instead match prose or other incidental text. |
| `import ` | Rust commonly imports with `use`; this can match comments or other incidental text. |
| `TODO` | Can match comments in Rust, but its frequency depends on the repository. |
| `class ` | Rust uses constructs such as `struct` and `enum`, rather than a `class` keyword; incidental matches are possible. |
| `interface ` | Rust uses traits for shared behavior rather than an `interface` keyword; incidental matches are possible. |

These are text searches, not syntax-aware queries: an incidental match is still
a match. For example, `rg -n 'use ' bench/refs/rust-project` illustrates a
Rust-oriented import search. It is not one of the measured patterns, nor is it
a complete search for every form of Rust import.

## Reading the saved result

The [saved JSON](benchmarks-v2.json) records a cross-language run on
2026-10-17 against `rust-project`, a sample of Tokio at commit `6c03e03`.
Its Rust grep mean ratio is **0.8782** (about **12.2% savings**), and its
pooled Rust overall ratio is **0.4466** (about **55.3% savings**). Savings are
`(1 - ratio) × 100%`; these are per-call sample means, not total session
savings. The JSON's top-level `samples` and `aggregate` belong to the separate
plugin-self run, not Tokio. The reference section retains per-tool aggregates,
but not individual Rust grep samples or match counts, so it cannot establish
which patterns matched or how many matches they produced in that run.

A pattern with no output contributes no grep sample, not a zero-savings sample.
If no patterns produce samples, the grep aggregate defaults to ratio 1; that
fallback is not a measurement. Short results often need no truncation and can
have ratio 1. Each resulting pattern ratio has equal weight in the grep mean;
the number of grep samples also affects grep's weight in the pooled read, grep,
and edit mean. The edit samples are the same synthetic edits for all three
reference repos. Pattern choice and result size therefore matter when comparing
languages, independently of any differences in compression behavior.

The grep baseline is plain `rg -n` output, compared with the no-genome
fallback. The benchmark does not measure the genome-RAG path, search speed, or
language coverage. To assess Rust-specific searches, run a separately reported
workload with representative Rust patterns and sample and match counts; do not
substitute its results into the existing fixed-workload comparison. See the
[methodology guide](benchmark-methodology-guide.md) for aggregation and
reproduction details.
