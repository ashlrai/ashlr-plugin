# AI-generated plates

Three images feed the hero video. Generate them manually with Grok Imagine or
Nanobanana using the prompts below, pick best-of-N, save at `1920×1080` (or
higher; Remotion will scale down). Drop the PNGs in this directory with the
exact filenames the compositions expect.

## `b1-ledger.png` — B1 pre-roll establishing shot

> Macro shot of a leather-bound accountant's ledger open on a worn oak desk,
> parchment pages with faint handwritten token tallies, amber lamp light,
> shallow depth of field, cinematic, 16:9 — in the style of a Wes Anderson
> establishing shot but earthier.

Recommended: Grok Imagine. Photorealism + cinematic framing.

## `b2-parchment.png` — B2 texture plate

> Clean aged parchment texture, subtle fibers, warm off-white #F3EADB, no
> markings, seamless, 1920×1080.

Recommended: Nanobanana. Precise color matching and seamless tiling.

## `b5-tagline.png` — B5 tagline card background

> Heavy-weight parchment with a single pressed wax seal in accountant's red
> #8B2E1A, centered composition with large negative space above and below
> for serif typography, shadow detail visible, 1920×1080.

Recommended: either — generate twice, pick the better take.

## If you skip this

The compositions fall back to flat parchment (`#F3EADB`) without the texture
plates. The video still ships cleanly; it just loses the cinematic mood the
plates add. `video/src/compositions/TaglineCard.tsx` already handles the
fallback.
