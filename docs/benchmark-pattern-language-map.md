# Benchmark grep pattern language map

The [benchmark description](benchmarks.md#multi-repo-reference-set) uses the
same five text searches across its TypeScript, Python, and Rust reference
repositories. The [public benchmark data](../site/public/benchmarks-v2.json)
also records these exact strings in `samples.ashlr__grep`. The space inside
each code span is significant; only `TODO` has no trailing space.

| Search string | Common association | Rust caveat |
| --- | --- | --- |
| `function ` | JavaScript/TypeScript function keyword | Rust functions use `fn`; this search can instead match incidental text. |
| `import ` | TypeScript and Python import keyword | Rust commonly uses `use` for imports. |
| `TODO` | Project comment convention across languages | Rust comments can contain it, but frequency depends on the project. |
| `class ` | TypeScript and Python class keyword | Rust uses constructs such as `struct` and `enum`, rather than a `class` keyword. |
| `interface ` | TypeScript interface keyword | Rust uses `trait` for shared behavior, rather than an `interface` keyword. |

These are text searches, not syntax-aware queries: comments and strings can
match, and a match does not establish that a declaration was found. Even
Rust-oriented searches such as `use ` or `fn ` are illustrative alternatives,
not complete syntax-aware searches or patterns measured in this workload.

## What the sources establish

The public JSON's top-level samples are from the plugin-self run dated
**2026-04-25**, not individual samples from the Rust reference repository.
Its recorded methodology uses `rg --json`. The later reference results in
`benchmarks.md` use plain `rg -n` and a no-genome fallback; their baseline
changed on 2026-10-17. Do not combine the public sample ratios with those later
reference results or treat the public samples as Rust match counts.

In the documented reference workload, a search with no output contributes no
grep sample; it is not counted as zero savings. Short output can leave little
to truncate, and the grep mean weights the remaining pattern ratios equally.
If none produces a sample, the aggregate defaults to ratio 1 (0% savings), a
fallback rather than a measurement. Pattern selection and match volume can
therefore affect the comparison, but the saved reference aggregates do not
establish which patterns matched Rust or why its result differs. These results
measure output-size savings, not search speed, language coverage, or total
session savings. No new measurements are reported in this map.
