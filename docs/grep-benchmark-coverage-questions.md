# Grep benchmark coverage questions

## Which searches does the benchmark use?

The [runner](../scripts/run-benchmark.ts) searches every repository with the
same five patterns, in this order. Each string except `TODO` ends in a space,
which is part of the pattern:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

These are text searches, so matches can occur in comments or strings as well
as code. They are a fixed workload for comparing output-size savings, not a
test of language coverage, search recall, or speed.

## Why might the patterns match Rust less often?

Rust commonly uses `fn` and `use` for functions and imports, and `struct`,
`enum`, and `trait` instead of `class` and `interface`. The corresponding
benchmark patterns can miss those declarations or match incidental text.
`TODO` can occur in comments, but its frequency varies by repository. For
example, `rg -n 'use ' <repo>` is a Rust-oriented search; it is not one of the
five measured patterns or a complete test of Rust imports.

## What does a low match rate do to the result?

A pattern with no output contributes no grep sample, rather than a sample
with zero savings. The grep mean weights the remaining pattern ratios equally;
if none produce output, it defaults to a ratio of 1 (0% savings), a fallback
rather than a measurement. Few matches can also yield short output with little
to truncate, though line length matters too. Fewer grep samples change their
weight in the overall mean, which pools individual read, grep, and edit
samples. A count of matching patterns does not establish coverage or recall.

The saved reference aggregates do not include individual Rust grep samples
or match counts, so they cannot prove which patterns matched or explain a
difference between repositories. To assess Rust-idiomatic searches, measure a
representative workload separately and record the revision and match counts;
do not treat it as the fixed benchmark. See [benchmarks](benchmarks.md) for
the published results and methodology.
