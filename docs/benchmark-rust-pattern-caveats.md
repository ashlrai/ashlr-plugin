# Rust grep pattern caveats

The [benchmark](benchmarks.md) uses one fixed grep workload for every
reference repository. Its searches can undercount Rust constructs because the
strings are drawn from generic code-search idioms, not Rust syntax. They count
matching text lines, not functions, imports, types, or traits. A lower count
does not by itself establish lower search coverage or a difference in speed.

## Fixed workload

The four strings other than `TODO` end with a space:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

| Pattern | Why it can miss Rust code |
| --- | --- |
| `function ` | Rust function declarations use `fn`, including `async fn`, rather than `function`. |
| `import ` | Rust commonly imports names with `use`, including `pub use`, rather than `import`. |
| `TODO` | It can occur in Rust comments, but only finds that text; its frequency depends on project conventions. |
| `class ` | Rust uses types such as `struct` and `enum`, not a `class` keyword. |
| `interface ` | Rust uses `trait` for shared behavior, not an `interface` keyword. |

These are text searches, so comments and strings can also produce hits. For
example, in this illustrative file all five patterns match the comment, while
none of them finds the declarations below it:

```rust
// TODO: document the function import class interface examples
use std::io;
pub struct Task;
pub enum State { Ready }
pub trait Run { fn run(&self); }
async fn execute() {}
```

The trailing spaces matter: `class ` matches `class example`, but not `class,`
or `class` at the end of a line. Likewise, a search for `use ` or `fn ` is a
useful Rust-oriented illustration, not a complete syntax-aware query: spacing,
line breaks, comments, strings, and other forms affect text-search results.

## Interpreting the reported result

The [saved benchmark data](benchmarks-v2.json) reports the `rust-project`
reference sampled from Tokio at `6c03e03` on 2026-10-17: its grep mean ratio
is **0.8782** (about **12.2% savings**). This is a mean of per-pattern output
token ratios against plain `rg -n`, using the no-genome fallback; it is not a
count of Rust constructs, a speed measurement, or total session savings.

A pattern with no output contributes no sample, rather than a zero-savings
sample. If none produce output, the grep aggregate falls back to ratio 1
(0% savings), which is not a measurement. Short output may need no truncation,
while longer output offers more to truncate. Each resulting pattern ratio has
equal weight in the grep mean, and the number of grep samples also affects its
weight in the pooled read/grep/edit mean. The saved reference aggregates do
not retain individual Rust patterns or match counts, so they cannot establish
which searches matched or why the recorded ratio differs from another repo.

For a Rust-specific assessment, run representative searches separately, record
the exact patterns, repository revision, matching-line and sample counts, and
report their results separately from the fixed cross-language workload. See
the [methodology guide](benchmark-methodology-guide.md) and
[pattern selection guide](benchmark-pattern-selection.md) for more context.
