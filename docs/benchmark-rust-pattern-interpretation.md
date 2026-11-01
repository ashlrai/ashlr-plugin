# Interpreting the Rust benchmark patterns

The [benchmark](benchmarks.md) runs the same five grep searches in every
reference repository. Four include a trailing space:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

## Why the patterns can match less Rust code

| Search string | Interpretation in Rust |
| --- | --- |
| `function ` | Rust functions use `fn`, including `async fn`. |
| `import ` | Rust commonly brings names into scope with `use` or `pub use`. |
| `class ` | Rust uses types such as `struct` and `enum`, not a `class` keyword. |
| `interface ` | Rust uses `trait` for shared behavior, not an `interface` keyword. |
| `TODO` | This can match comments; its frequency depends on the project. |

The first four may have few matches because they are not the usual Rust
keywords. They are text searches, so matches can still occur in comments,
strings, or other incidental text. `TODO` is not a search for a Rust language
construct. For example, `rg -n 'use ' <repo>` is a Rust-oriented search, but
it was not part of this workload and is not a complete syntax-aware import
query.

## What the measurements support

The [saved data](benchmarks-v2.json) records a cross-language run on
2026-10-17 using `rust-project`, a sample of Tokio at `6c03e03`. Its grep
mean ratio is **0.8782**, or **12.2% savings**; the pooled read/grep/edit
ratio is **0.4466**, or **55.3% savings**. Savings are `(1 - ratio) × 100%`.
These are sample means, not total session savings. The JSON's top-level
`samples` and `aggregate` describe a separate plugin-self run, not Tokio.
The reference-repo section retains aggregates but not individual Rust grep
samples or match counts, so it cannot establish which patterns matched or why
the Rust result differs from another repository.

The benchmark compares estimated output tokens from plain `rg -n` with the
no-genome fallback. A short result often offers little to truncate and can
show little or no savings. A pattern with no output contributes no sample,
not a zero-savings sample. The grep mean weights the remaining pattern ratios
equally; if there are none, its ratio defaults to 1, which is a fallback rather
than a measurement. The overall mean pools individual read, grep, and synthetic
edit samples, so the number of grep samples also affects grep's weight.

Consequently, the Rust figure describes this fixed workload in the sampled
files; it does not predict savings for idiomatic Rust searches, establish
language coverage, or measure search speed. For that question, run a separate
representative Rust workload, record the revision, patterns, matching-line and
sample counts, and report its results separately. Measure timing separately
if speed is the question. See the [methodology guide](benchmark-methodology-guide.md)
for the broader benchmark design.
