# Benchmark methodology source map

Both saved v2 results contain a **top-level `methodology` string** (JSON path
`$.methodology`). The value is embedded text, with JSON-escaped newlines; it is
not a separate methodology object. Compare the decoded strings when checking
whether they match.

| Source | Role | Recorded `measuredAt` | `repo.commit` |
| --- | --- | --- | --- |
| [docs/benchmarks-v2.json](benchmarks-v2.json) | Plugin-self result used by the benchmark page | 2026-10-19T17:23:26.418Z | `364a4030d3bdb02271c04e18d1632ef6bd00d8f1` |
| [site/public/benchmarks-v2.json](../site/public/benchmarks-v2.json) | Static file linked as the benchmark JSON download | 2026-10-19T17:23:26.418Z | `364a4030d3bdb02271c04e18d1632ef6bd00d8f1` |

## Comparison

**The methodology strings match exactly.** Both describe a plain `rg -n`
baseline, 300-column previews, and whole lines retained from the head and tail
above 4,000 characters. Both snapshots record the same plugin-self provenance
(`measuredAt` and `repo.commit`). The `caveat` also distinguishes the self-repo
and cross-language measurement dates.

## How the sources reach readers

[`scripts/run-benchmark.ts`](../scripts/run-benchmark.ts) defines the
methodology text and writes it into benchmark output; its default output is the
docs JSON. [`scripts/benchmark-refs.ts`](../scripts/benchmark-refs.ts) merges
reference results into that file while retaining existing fields. The
[benchmark page](../site/app/benchmarks/page.tsx) loads the docs JSON at build
time and displays its `methodology`, while its download link points to the
separate static public JSON. A refresh of one file does not by itself establish
that the other was refreshed.

To recheck the exact decoded text from the repository root:

```sh
node -e 'const fs = require("node:fs"); const read = p => JSON.parse(fs.readFileSync(p, "utf8")).methodology; console.log(read("docs/benchmarks-v2.json") === read("site/public/benchmarks-v2.json") ? "match" : "differ");'
```

Update this map and its [comparison test](../__tests__/benchmark-methodology-source-map.test.ts)
when either snapshot changes. For the broader workload and limitations, see the
[benchmark methodology guide](benchmark-methodology-guide.md).
