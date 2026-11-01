# Where to find the benchmark methodology

Each v2 benchmark snapshot contains its methodology in the top-level
`methodology` string (`$.methodology`). It is embedded in the JSON, not a
separate file or object; parse the JSON to read the escaped line breaks.

| Snapshot | Location and use |
| --- | --- |
| [`docs/benchmarks-v2.json`](benchmarks-v2.json) | Repository benchmark data. The [benchmark page](../site/app/benchmarks/page.tsx) reads this file at build time and displays its `methodology` field. |
| [`site/public/benchmarks-v2.json`](../site/public/benchmarks-v2.json) | Static public asset served as `/benchmarks-v2.json`; the benchmark page links to it as the JSON download. Its own top-level `methodology` describes that snapshot. |

These are separate saved runs, and their methodology strings currently differ
in the grep description. Updating one does not automatically update the other;
check the snapshot and its measurement date before interpreting a result. See
the [methodology source map](benchmark-methodology-source-map.md) for the
recorded dates, commits, and differences, and the [methodology guide](benchmark-methodology-guide.md)
for the workload and its limitations.

To print either decoded field from the repository root:

```sh
node -e 'const fs = require("node:fs"); for (const p of process.argv.slice(1)) console.log(p, JSON.parse(fs.readFileSync(p, "utf8")).methodology)' docs/benchmarks-v2.json site/public/benchmarks-v2.json
```
