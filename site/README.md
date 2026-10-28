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
