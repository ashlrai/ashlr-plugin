# Documentation freshness

Run `bun run fresh:sync` after a release metadata change and `bun run fresh:check`
to detect drift without writing files. Both commands also work with Node directly:
`node scripts/freshness/sync.mjs` and `node scripts/freshness/check.mjs`.
Run tests with `bun run fresh:test` (or `node --test scripts/freshness/freshness.test.mjs`).

The package version comes from root `package.json`. The latest stable release and
date come from the first released `## [X.Y.Z] - YYYY-MM-DD` changelog heading;
Unreleased and prereleases are ignored. Package and released versions can differ
while preparing a release. Historical prose and release sections stay handwritten.

Generated regions use an opening `<!-- fresh:begin NAME -->` marker on its own
line and a closing `<!-- fresh:end -->` marker. Supported names:

- `version-badge`: linked package version badge.
- `install`: pinned global npm installation.
- `version-table`: package and released versions, plus existing maintenance commands.
- `example-pin`: exact package dependency pin for examples.
- `release-summary`: latest documented release and package version.

The generator discovers marked Markdown, MDX and HTML files recursively in `docs/`
and `examples/`, plus root README, FAQ and changelog. It never follows symlinked
directories. Unknown, nested, duplicate and malformed markers fail before any
writes. Required blocks on the main entry pages also fail if removed. Add new
required placements to `required` in `core.mjs`.

`version:check` remains the manifest checker and `gen:tool-catalog -- --check`
remains the tool catalog checker. Their package script definitions are required;
the freshness commands do not execute or duplicate them. No network is needed.
