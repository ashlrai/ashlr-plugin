# Benchmark pattern selection

The [token-savings benchmark](benchmarks.md) uses a fixed set of grep searches
across its reference repositories. Keeping the searches fixed helps compare the
same workload, but it does not make that workload equally representative of
each language. In particular, a lower Rust match rate can reflect the selected
strings and the sampled files, rather than a general property of Rust or grep.

## Recorded workload

The [saved benchmark data](benchmarks-v2.json) records these five patterns in
the plugin-self grep samples, in this order. The four strings other than `TODO`
end with a space; the space is part of the search.

```json
["function ", "import ", "TODO", "class ", "interface "]
```

The same fixed workload was used for the reference results described in
[benchmarks.md](benchmarks.md). These are text searches, so a hit may occur in
comments, strings, or other incidental text, not just declarations.

| Pattern | Why Rust results can differ |
| --- | --- |
| `function ` | Rust functions use `fn`, so this can instead find prose or other incidental text. |
| `import ` | Rust commonly uses `use` for imports; this may find incidental text instead. |
| `TODO` | Comments can contain it in any language, but its frequency depends on the files and project. |
| `class ` | Rust has constructs such as `struct` and `enum`, rather than a `class` keyword. |
| `interface ` | Rust uses traits for shared behavior, rather than an `interface` keyword. |

For example, `rg -n 'use ' bench/refs/rust-project` is an illustrative
Rust-oriented import search, not a pattern in the recorded workload or a
complete search for Rust imports. Different repositories, revisions, file
selection, comments, and search strings can all change how many matches appear.

## Interpreting the saved Rust result

The cross-language run is dated **2026-10-17**. Its `rust-project` reference is
sampled from Tokio at `6c03e03`; the saved grep mean ratio is **0.8782**, or
about **12.2% savings**. Its pooled overall ratio is **0.4466**, or about
**55.3% savings**. A ratio compares estimated output tokens with the raw
baseline; savings are `(1 - ratio) × 100%`. These figures are sample means,
not total session savings.

The JSON's top-level `samples` and `aggregate` describe a separate plugin-self
run. Its `byRepo.rust-project` section retains aggregates, not individual
Rust grep samples or match counts. Consequently, the saved data does not say
which patterns matched Tokio or how many matches they produced. It does not
establish a Rust match rate or prove why this particular aggregate differs.

A search with no output contributes no grep sample. If none produces a sample,
the aggregate falls back to ratio 1 (0% savings), which is not a measurement.
Short output may need no truncation and yield a ratio of 1; longer output can
offer more to truncate. The grep mean weights each resulting pattern ratio
equally, and the number of grep samples also changes grep's weight in the
pooled read/grep/edit mean. The measured baseline is plain `rg -n`, compared
with the no-genome fallback, and does not measure search speed or language
coverage. See the [Rust patterns guide](benchmark-rust-patterns.md) and
[methodology guide](benchmark-methodology-guide.md) for further context.

For a Rust-specific study, select representative searches for the task and
files, record each exact pattern and its match and sample counts, and report
the results separately from this fixed-workload comparison. Include the
repository revision and benchmark method so the comparison can be reproduced.
