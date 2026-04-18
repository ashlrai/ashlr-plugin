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
