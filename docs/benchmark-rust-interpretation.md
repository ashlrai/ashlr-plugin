# Reading the Rust benchmark result

Short guide to the Rust match-rate caveat documented in
[benchmarks.md](benchmarks.md). Longer treatments:
[Rust patterns](benchmark-rust-patterns.md) and
[interpreting the Rust benchmark patterns](benchmark-rust-pattern-interpretation.md).

## The caveat

The grep benchmark runs one fixed set of five text patterns in every
reference repo (`GREP_PATTERNS` in `scripts/run-benchmark.ts`):

```json
["function ", "import ", "TODO", "class ", "interface "]
```

These are TypeScript/Python-flavored. Rust spells the same ideas differently,
so most of them can have a low match rate in `rust-project` (Tokio).

## Affected patterns

| Pattern | Rust equivalent | Effect |
| --- | --- | --- |
| `function ` | `fn`, `async fn` | Low match rate |
| `import ` | `use`, `pub use` | Low match rate |
| `class ` | `struct`, `enum` | Low match rate |
| `interface ` | `trait` | Low match rate |
| `TODO` | none (a comment convention) | Not affected by syntax; depends on the repo |

Low-rate patterns can still match comments or strings. A pattern with no
matches produces no sample (it is skipped, not counted as 0% savings).

## What it does to the number

Few matches means short `rg -n` output, which leaves the fallback little to
truncate, so measured savings shrink. The saved run (2026-10-17) shows
`rust-project` at a grep mean of about **−12.2%**, against −30.4% for
`node-sdk` and −39.1% for `python-lib`. The grep mean is an equal-weighted
mean of the samples that exist, so which patterns matched changes the result.

## How to use it

- Compare Rust grep savings to other languages only with this caveat attached.
- Do not treat −12.2% as the savings of Rust-idiomatic searches such as
  `rg -n 'use '` (illustrative, not measured here).
- For a Rust claim, run a separate Rust-oriented workload and record the
  revision, patterns and match counts.
- The saved data keeps no per-pattern Rust samples or match counts, so which
  patterns matched cannot be recovered from it.
