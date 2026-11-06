# Rust grep benchmark caveat

The [benchmark](benchmarks.md#multi-repo-reference-set) uses the same five
text-search patterns in every reference repository. Each pattern except
`TODO` ends with a space:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

Four patterns can miss idiomatic Rust declarations: `function ` searches
for text where Rust uses `fn`, `import ` where Rust commonly uses `use`,
`class ` where Rust uses types such as `struct` and `enum`, and `interface `
where Rust uses `trait`. They can still match incidental text, including
comments. `TODO` can match Rust comments, but its frequency depends on the
repository. For example, `rg -n 'use ' <repo>` is a Rust-oriented search,
not one of the measured patterns or a complete measure of imports.

A pattern with no matches contributes no grep sample, rather than a sample
with zero savings. Short results can leave little output to truncate. The
grep mean weights the remaining pattern ratios equally; if no pattern
produces a sample, the aggregate falls back to ratio 1 (0% savings), which
is not a measurement. The number of grep samples also affects their weight
in the overall mean, which pools read, grep, and edit samples.

The reported Rust result describes this fixed workload and the ripgrep
fallback against plain `rg -n` output; it does not measure genome-RAG, search
speed, or savings for Rust-idiomatic searches. To assess those searches,
measure a representative workload separately and record the repository
revision, exact patterns, and match and sample counts. See the
[benchmark methodology](benchmark-methodology-guide.md) for more detail.
