/**
 * Design tokens shared across the ashlr CLI, landing page, and hero video.
 *
 * Kept in sync with:
 *   - `site/app/globals.css` lines 3-37 (parchment palette)
 *   - `servers/_status-line-cells.ts` (brand green, pulse, context tiers)
 *
 * Every hex value here must match the corresponding CSS var. When we update
 * one, we update the other in the same commit.
 */

export const paper = "#F3EADB";
export const paperDeep = "#ECE2CE";
export const ink = "#121212";
export const inkSoft = "rgba(18, 18, 18, 0.82)";
export const inkMid = "rgba(18, 18, 18, 0.55)";
export const inkFaint = "rgba(18, 18, 18, 0.28)";
export const inkWhisper = "rgba(18, 18, 18, 0.09)";

// Accountant's red — the "debit" column color and the brand accent.
export const debit = "#8B2E1A";
export const debitDeep = "#5E1E11";

// Ledger green (rare accent, not the terminal sparkline).
export const credit = "#4F5B3F";

// Status-line sparkline palette — mirrors BRAND_DARK / BRAND_LIGHT in
// servers/_status-line-cells.ts.
export const brandDark = "#00d09c";
export const brandLight = "#7cffd6";
export const pulseWhite = "#FFFFFF";

// Terminal chrome used in beats B1-B4.
export const terminalBg = "#0C0C0A";
export const terminalFg = "#F3EADB";
export const terminalDim = "rgba(243, 234, 219, 0.55)";

// Type stack.
export const fontSerif = "Fraunces, ui-serif, Georgia, serif";
export const fontSans = "'IBM Plex Sans', system-ui, sans-serif";
export const fontMono = "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace";

// Canonical composition dimensions.
export const video = {
  width: 1920,
  height: 1080,
  fps: 60,
  durationFrames: 1800, // 30 s
} as const;

export const videoVertical = {
  width: 1080,
  height: 1920,
  fps: 60,
  durationFrames: 1800,
} as const;
