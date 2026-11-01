# Benchmark v2 read measurement

This describes the `ashlr__read` measurement recorded in
[`docs/benchmarks-v2.json`](benchmarks-v2.json), not a new benchmark run. The
snapshot's `measuredAt` and `repo.commit` identify the plugin-self run; its
`caveat` calls the benchmark synthetic and notes that read samples change with
the commit, so runs on different commits are not like-for-like.

For each sampled file, the recorded methodology measures the raw content,
wraps it in a `tool_result` message, applies `snipCompact()`, and measures the
resulting content. The JSON records:

| Field | Meaning and unit |
| --- | --- |
| `rawBytes`, `ashlrBytes` | Size before and after compaction, in bytes. |
| `rawTokens`, `ashlrTokens` | Estimated tokens before and after compaction, using the characters/4 heuristic rather than a model tokenizer. |
| `ratio` | `ashlrTokens / rawTokens`, a unitless ratio of estimated token counts; lower means more savings. It is not a byte ratio. |

The methodology says files below 2 KB are excluded and that `snipCompact` fires
only on tool results over 2,000 characters. It describes deterministic sampling
using the repository HEAD commit SHA as a seed, with up to four files in each of
the 2–5 KB, 5–15 KB, 15–50 KB, and 50+ KB buckets. These are file-size buckets;
the compaction threshold is expressed in characters.

The saved `samples.ashlr__read` array contains 16 entries, including a video
and a lockfile as well as source files. The methodology's aggregation paragraph
says read has 15 samples; that prose does not match the saved array. Use the
array for the recorded entries. The `aggregate.ashlr__read` mean, p50, p90,
and confidence interval are summaries of sample ratios, not byte counts or
latency measurements. `aggregate.overall.mean` pools read, grep, and edit
sample ratios and is not a read-only result. Reference-repository fields have a
separate `crossLanguageMeasuredAt`; they are not the plugin-self read samples.
