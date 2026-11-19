# ashlr landing site

Next.js 15 App Router site for [plugin.ashlr.ai](https://plugin.ashlr.ai): the landing page, the Fumadocs documentation under `content/docs/`, and `/llms.txt`. Merges to `main` that touch `site/**` deploy it through `.github/workflows/deploy-site.yml`.

## Prerequisites

- bun >= 1.1
- Node >= 20 (for Next.js 15)

## Install

```bash
cd site
bun install
```

## Check

```bash
bun run check   # regenerates docs data and typechecks the site
```

`bun run check` and `bun run build` regenerate `lib/docs.generated.json`. Leave
that file out of your commit; it is a hot file that collides across parallel PRs
(see [AGENTS.md](../AGENTS.md#hot-files)).

## Dev

```bash
bun run dev
# http://localhost:3000
```

## Build

```bash
bun run build
```

## Discoverability checks

From the repository root, after installing root and site dependencies:

```sh
HOME=$(mktemp -d) bun test __tests__/agent-docs.test.ts
(cd site && HOME=$(mktemp -d) bun run build)
HOME=$(mktemp -d) python3 -m unittest discover -s site/tests -p '*_test.py' -v
```

The acceptance suite parses the built sitemap XML, JSON-LD, LLM index, and every
public page listed in the sitemap. It checks canonical URLs, heading order,
descriptions, OpenGraph metadata, and complete documentation coverage. Account,
authentication, and admin screens are outside the public discovery sitemap.
Status pages use the separate `status.ashlr.ai` canonical host.

`/llms.txt` and `/llms-full.txt` are regenerated during the existing build from
`../README.md` and the Fumadocs source pages in `content/docs/`. Source read errors
fail the build instead of publishing an incomplete corpus. The application
schema takes its version and repository URL from the root package manifest.

Ship these changes through the existing merge-to-main deployment path.

## Deploy

Nobody deploys the site from a laptop. `.github/workflows/deploy-site.yml` runs
on every pull request and push to `main` that touches `site/**`:

- It installs dependencies and runs `bun run build`, so a broken build shows up
  on the PR.
- On a push to `main` (or a manual dispatch) it deploys the build to production
  on Vercel.
- On a pull request it deploys a Vercel preview.

Both deploy steps run only when the repository's Vercel secrets are set;
without them the workflow is a build-only check. It is not part of `CI Gate`.

## React Bits components

Components are copy-pasted into `components/bits/` (the npm `react-bits` package
is an unrelated React Native utility — reactbits.dev is a copy-paste library):

- `DecryptedText` — hero headline character scramble on mount
- `CountUp` — animated token counter
- `Magnet` — cursor-pull effect on the CTA button
- `Threads` — animated sinusoidal lines for the hero background

## SEO validation

Use-case copy lives in `lib/use-cases.ts`. Keep product behavior in claim blocks
with at least one source link to relevant repository documentation or version-pinned code. The
shared page template renders those citations beside the claim. Suggested steps
and prompts are editorial guidance, not measured performance results.

From the repository root:

```sh
HOME=$(mktemp -d) bun test __tests__/site-seo.test.ts
```

After a production build, validate the generated HTML and sitemap:

```sh
HOME=$(mktemp -d) python3 site/scripts/check-seo.py
```

The sitemap is generated statically while Git history is available. `lastmod`
comes from the latest commit affecting a page's sources or shared presentation,
not the build clock. New uncommitted content receives its own timestamp after
it is committed. Source archives without Git omit unknown dates; the production
validator requires dates, so validate a Git checkout before shipping. A shallow
checkout can only report dates available in its history; use full history for
accurate per-page dates. The status site's cross-domain canonical is excluded
from this site's sitemap, as are private application routes.

Local performance runs use a production server and Lighthouse 12.8.2 with the
same mobile defaults before and after changes:

```sh
cd site
bun run start --hostname 127.0.0.1 --port 3100
# In another terminal, from the repository root:
HOME=$(mktemp -d) bunx --package lighthouse@12.8.2 lighthouse http://127.0.0.1:3100 \
  --chrome-flags="--headless --no-sandbox" --only-categories=performance,seo \
  --output=json --output-path=/tmp/ashlr-lighthouse.json
```

Keep raw reports outside the worktree. `scripts/summarize-lighthouse.py` accepts
`label=/path/to/report.json` arguments and emits compact metrics, report hashes
and warnings. The measurements for this change are in `performance/lighthouse.json`.

These are local lab measurements. Lighthouse's navigation run does not measure
field INP or prove production Core Web Vitals results.
