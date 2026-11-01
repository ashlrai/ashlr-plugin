# Benchmark result locations

The v2 results are saved as two separate JSON snapshots. Each contains its own
top-level `methodology` string (`$.methodology`), alongside the samples,
aggregates, measurement time, and repository revision for that snapshot.

| Result file | Use | Recorded `measuredAt` | `repo.commit` |
| --- | --- | --- | --- |
| [`docs/benchmarks-v2.json`](benchmarks-v2.json) | Read by the [benchmark page](../site/app/benchmarks/page.tsx) at build time. | `2026-10-19T17:23:26.418Z` | `364a4030d3bdb02271c04e18d1632ef6bd00d8f1` |
| [`site/public/benchmarks-v2.json`](../site/public/benchmarks-v2.json) | Static asset served at `/benchmarks-v2.json`, linked from the page as a download. | `2026-04-25T00:50:03.066Z` | `91e2c583ab7c0fd6a91e3f6290fad176adcdc971` |

The recorded methodologies describe estimating tokens as characters divided by
four. For reads, each describes sampling files by size using a commit-derived
seed and comparing raw content with `snipCompact` output. For edits, each
describes three synthetic before-and-after comparisons against a diff summary.
Per-tool statistics summarize sample ratios, and the overall mean pools
individual ratios, weighting tools by their sample counts. The saved arrays
contain 16 read samples in each snapshot, although the methodology text says
15; use the arrays for the recorded count.

The grep descriptions differ. The docs snapshot describes a plain `rg -n`
baseline and a no-genome fallback with 300-column previews and whole head and
tail lines retained above 4,000 characters. The public snapshot describes an
`rg --json` baseline and truncation with a 2,000-character head and
1,000-character tail. These are descriptions recorded with different runs;
they do not establish that the results are directly comparable. Both describe
the no-genome baseline, not the indexed grep path.

The docs snapshot also contains cross-language results with their own
`crossLanguageMeasuredAt` (`2026-10-17T02:32:44.002Z`), separate from its
plugin-self `measuredAt`. Its `caveat` notes that the benchmark is synthetic
and that read samples change with the commit. Updating one result file does
not automatically refresh the other. Check the fields in the relevant snapshot
before using a figure; see the [methodology source map](benchmark-methodology-source-map.md)
and [methodology guide](benchmark-methodology-guide.md) for further detail.
