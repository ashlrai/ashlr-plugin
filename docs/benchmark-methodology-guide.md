# Benchmark methodology guide

This guide explains how to read the token-savings benchmark in
[benchmarks.md](benchmarks.md) and its saved data in
[benchmarks-v2.json](benchmarks-v2.json). It describes the benchmark workload,
not a prediction of savings in a complete user session. For the recorded results
and their dates, use those sources rather than treating this guide as a new run.

## What is measured

[run-benchmark.ts](../scripts/run-benchmark.ts) compares output representations
without an MCP or Claude Code session. It exercises `snipCompact` for reads,
the ripgrep fallback for greps, and a modeled summary for synthetic edits.
It does not measure latency, throughput, end-to-end session savings, or the
genome-RAG grep path.

| Operation | Baseline | Compared output and workload |
| --- | --- | --- |
| Read | Full file content | `snipCompact` applied to a tool-result wrapper for sampled tracked files. Files under 2,048 bytes are excluded. |
| Grep | Plain `rg -n` results in `path:line:text` form | The no-genome fallback uses ripgrep's 300-column preview and, above 4,000 characters, retains whole lines from the head and tail with an omission notice. |
| Edit | Synthetic before-and-after search and replacement text | A modeled header-only summary for three exact, unique edits of different sizes. These are the same synthetic edits for each repo, not observed user edits. |

The read sampler uses `git ls-files`, groups eligible files into four size
buckets (2–5, 5–15, 15–50, and 50+ KiB), and selects up to four per bucket
using a seed derived from HEAD. A matching commit alone is not enough if the
working tree or tool versions differ; use a clean checkout for comparison.
The sample can include tracked non-source artifacts. Small files and other tool
families are outside this benchmark's scope. The real edit redirect also has a
small-edit guard; the direct synthetic measurement does not model that routing.

## Ratios and aggregation

Each sample records byte counts and estimated token counts. Token counts use
the plugin's approximately characters/4 estimator, not a model tokenizer. The
sample `ratio` is estimated output tokens divided by estimated baseline tokens
(`naiveTokens` for edits). Savings are `(1 - ratio) × 100%`; a ratio above 1
means the output is larger. The ratio is not calculated from the byte fields.

Per-tool means give each sample ratio equal weight; p50, p90, and a bootstrap
confidence interval describe the sampled ratios. `aggregate.overall.mean`
pools individual read, grep, and edit ratios, so tools contribute in proportion
to their sample counts. It is neither a byte-weighted total nor an average of
the three tool means. The reference runner then averages the per-repo overall
means equally for `crossLanguageMean`, and derives `crossLanguageSavingsPct`
from that ratio. Neither mean is a complete-session savings figure.

In the saved JSON, `samples`, `aggregate`, `repo`, and `measuredAt` describe
the plugin-self run; `byRepo`, `byLanguage`, and `crossLanguage*` describe the
reference runs and have their own `crossLanguageMeasuredAt`. Check the `caveat`
and commit fields when comparing them: the two sections need not have been
measured at the same time, and sampled files can change with the commit.

## Fixed grep workload and Rust

Every repo is searched with the same five patterns. The spaces shown inside
four strings are part of the patterns:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

Rust commonly uses `use` and `fn`, along with structs, enums, and traits,
instead of several of these constructs. The fixed patterns can match incidental
text such as comments and may yield few matches. A Rust search for `use ` is
an illustrative alternative, not one of the measured patterns.

A pattern with no matches contributes no grep sample, not a zero-savings
sample. If none match, the grep aggregate defaults to ratio 1; that fallback
is not a measurement. A short result may fit without truncation and therefore
show no savings. Each remaining pattern ratio has equal weight in the grep
mean; the number of matching patterns also changes grep's weight in the pooled
overall mean. Match counts and pattern counts do not establish language
coverage or search speed. The recorded Rust result describes this fixed
workload and does not predict savings for Rust-idiomatic searches.

## Reproduce or extend

With Bun and ripgrep installed, use a clean git checkout and the same commit,
dependencies, and reference inputs for a like-for-like comparison. A dry run
avoids writing the benchmark JSON:

```bash
bun run scripts/run-benchmark.ts --repo /path/to/checkout --dry-run
bun run scripts/benchmark-refs.ts --dry-run
```

The reference runner can initialize and commit local git repositories in
`bench/refs/` if they are not already repositories, even during a dry run; use
a disposable checkout if that matters. Without `--dry-run`, the runners write
JSON; use `--out /tmp/bench.json` to choose a different destination. See
[benchmarks.md](benchmarks.md#extending-with-your-own-repo) for adding a
reference repo. For language-specific conclusions, design representative
search patterns and report them and their sample counts separately; use a
separate timing experiment for performance.
