// Chart theme tokens — shared across all chart primitives.
// Colors reference CSS custom properties where possible so light/dark mode works.
// The palette array is used for multi-series charts (line, grouped bar, etc.).

export const CHART_PALETTE = [
  "#c94f4f", // [0] debit red — primary series
  "#4f7bc9", // [1] blue
  "#4fc97b", // [2] green
  "#c9a44f", // [3] amber
  "#9b4fc9", // [4] purple
  "#4fc9c9", // [5] teal
  "#c97b4f", // [6] orange
  "#7bc94f", // [7] lime
] as const;

// Single-series default color (matches --debit red in the site theme)
export const CHART_COLOR_PRIMARY = CHART_PALETTE[0];

// Axis / grid
export const CHART_GRID_COLOR = "rgba(18,18,18,0.08)";
export const CHART_AXIS_COLOR = "rgba(18,18,18,0.35)";
export const CHART_AXIS_FONT_SIZE = 11;
export const CHART_AXIS_FONT_FAMILY = "var(--font-mono, ui-monospace, monospace)";

// Tooltip
export const CHART_TOOLTIP_BG = "#faf7f0"; // parchment — matches ledger-card bg
export const CHART_TOOLTIP_BORDER = "rgba(18,18,18,0.12)";
export const CHART_TOOLTIP_TEXT = "#121212";

// Gradient IDs (stable, one per chart type)
export const GRADIENT_ID_AREA = "areaFill";
