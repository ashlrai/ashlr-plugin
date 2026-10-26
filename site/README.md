# ashlr landing site

Next.js 15 App Router site for plugin.ashlr.ai. Ships alongside `docs/index.html`; DNS will flip when this is polished.

## Prerequisites

- bun >= 1.1
- Node >= 20 (for Next.js 15)

## Install

```bash
cd site
bun install
```

## Dev

```bash
bun run dev
# http://localhost:3000
```

## Build

```bash
bun run build
```

## Deploy to Vercel

```bash
# From the repo root, set the Vercel root directory to `site/`
# or deploy from the site/ directory:
cd site
bunx vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard and set:
- **Root Directory**: `site`
- **Framework Preset**: Next.js
- **Build Command**: `bun run build`
- **Output Directory**: `.next`

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
