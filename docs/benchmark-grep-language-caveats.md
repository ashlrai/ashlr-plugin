# Grep benchmark language caveats

The [benchmark](benchmarks.md#multi-repo-reference-set) uses the same fixed
searches for every reference repository. The [runner](../scripts/run-benchmark.ts)
uses these exact patterns, in order:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

The trailing space is part of every pattern except `TODO`. These are ripgrep
text patterns, not syntax-aware searches: matches can occur in comments,
strings, documentation, or code, and need not identify a declaration.

| Pattern | Why it may match less Rust code |
| --- | --- |
| `function ` | Rust function declarations normally use `fn`, not `function`. |
| `import ` | Rust typically brings names into scope with `use`. |
| `TODO` | This comment convention can occur in Rust, but its frequency varies by project. |
| `class ` | Rust has no `class` keyword; types may be declared with `struct` or `enum`. |
| `interface ` | Rust uses `trait` for shared behavior, not an `interface` keyword. |

For example, `use std::io;` and `fn run() {}` contain neither `import ` nor
`function `. A comment saying `// TODO: document the function example` can
match both `TODO` and `function ` without being either kind of declaration.
Rust-oriented searches such as `use ` and `fn ` are useful illustrative
alternatives, but they are not part of the measured workload and are not
complete syntax-aware queries.

## Reading the result

The runner compares plain `rg -n` output with the no-genome ripgrep fallback,
which limits long lines and truncates larger results. It estimates token savings
from the output sizes; it does not measure search speed, language coverage,
recall, or total session savings. Short results often leave little to truncate,
so fewer matches can mean less measured savings, although long individual lines
and output formatting also matter.

A pattern with no output contributes no grep sample, rather than a sample with
zero savings. The grep mean weights each resulting pattern ratio equally; if
there are no samples, the aggregate defaults to ratio 1 (0% savings), which
is a fallback rather than a measurement. A missing sample can also result from
an execution failure, so it is not by itself proof of zero matches. The pooled
overall mean weights individual read, grep, and edit samples, so a different
number of grep samples also changes the tool mix.

The reported Rust figure describes this fixed workload on that reference repo;
it does not establish which patterns matched, why its measured savings differ,
or what Rust-idiomatic searches would save. Compare pattern and sample counts
and match volumes from a fresh run before drawing cross-language conclusions;
the saved reference aggregates alone do not provide those counts. See the
[benchmark methodology](benchmark-methodology-guide.md) for the broader
measurement and the [Rust interpretation](benchmark-rust-pattern-interpretation.md)
for the limits of the saved results.
