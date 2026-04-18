/**
 * svg.ts — Badge SVG generation helpers.
 *
 * Ported from scripts/generate-badge.ts (pure functions only — no file I/O,
 * no stats reading). Keep in sync with the plugin's badge script if the
 * visual style evolves.
 */

// ---------------------------------------------------------------------------
// Types (re-exported so routes can import from one place)
// ---------------------------------------------------------------------------

export type Metric = "tokens" | "dollars" | "calls";
export type Style  = "flat" | "pill" | "card";

export interface BadgeOptions {
  metric: Metric;
  style:  Style;
}

export interface BadgeData {
  tokens: number;
  calls:  number;
  byDay:  Record<string, number>;
}

// ---------------------------------------------------------------------------
// Pricing / formatting
// ---------------------------------------------------------------------------

const PRICING: Record<string, { input: number; output: number }> = {
  "sonnet-4.5": { input: 3.0,  output: 15.0 },
  "opus-4":     { input: 15.0, output: 75.0 },
  "haiku-4.5":  { input: 0.8,  output: 4.0  },
};

function costFor(tokens: number, model = "sonnet-4.5"): number {
  const p = PRICING[model] ?? PRICING["sonnet-4.5"]!;
  return (tokens * p.input) / 1_000_000;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K tokens`;
  return `${n} tokens`;
}

export function fmtDollars(tokens: number): string {
  const c = costFor(tokens);
  if (c >= 1) return `$${c.toFixed(2)} saved`;
  return `$${c.toFixed(4)} saved`;
}

export function fmtCalls(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K calls`;
  return `${n} calls`;
}

export function rightLabel(data: BadgeData, metric: Metric, hasData: boolean): string {
  if (!hasData) return "no data yet";
  switch (metric) {
    case "tokens":  return `saved ${fmtTokens(data.tokens)}`;
    case "dollars": return fmtDollars(data.tokens);
    case "calls":   return fmtCalls(data.calls);
  }
}

// ---------------------------------------------------------------------------
// SVG geometry
// ---------------------------------------------------------------------------

const FONT      = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const BRAND     = "#00d09c";
const GREY      = "#4a5568";
const WHITE     = "#ffffff";
const BLACK_STOP = "#000000";

function approxTextWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 32) continue;
    if ("iIl|1.,;:!".includes(ch)) { w += 4; continue; }
    if ("mwMW".includes(ch))        { w += 9; continue; }
    w += 7;
  }
  return w;
}

function shieldGradients(): string {
  return `<defs>
  <linearGradient id="s" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0"   stop-color="${WHITE}"      stop-opacity="0.1"/>
    <stop offset="1"   stop-color="${BLACK_STOP}" stop-opacity="0.1"/>
  </linearGradient>
</defs>`;
}

// ---------------------------------------------------------------------------
// Style builders
// ---------------------------------------------------------------------------

function buildFlat(leftText: string, rightText: string): string {
  const lw = approxTextWidth(leftText) + 20;
  const rw = approxTextWidth(rightText) + 20;
  const W  = lw + rw;
  const H  = 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" role="img" aria-label="ashlr token savings badge">
  <title>ashlr · ${rightText}</title>
  <rect width="${lw}" height="${H}" fill="${BRAND}"/>
  <rect x="${lw}" width="${rw}" height="${H}" fill="${GREY}"/>
  <text x="${lw / 2}" y="14" font-family="${FONT}" font-size="11" fill="${WHITE}" text-anchor="middle">${leftText}</text>
  <text x="${lw + rw / 2}" y="14" font-family="${FONT}" font-size="11" fill="${WHITE}" text-anchor="middle">${rightText}</text>
</svg>`;
}

function buildPill(leftText: string, rightText: string): string {
  const lw = approxTextWidth(leftText) + 20;
  const rw = approxTextWidth(rightText) + 20;
  const W  = lw + rw;
  const H  = 20;
  const R  = 4;

  const clip      = `M${R},0 H${W - R} Q${W},0 ${W},${R} V${H - R} Q${W},${H} ${W - R},${H} H${R} Q0,${H} 0,${H - R} V${R} Q0,0 ${R},0 Z`;
  const leftPath  = `M${R},0 H${lw} V${H} H${R} Q0,${H} 0,${H - R} V${R} Q0,0 ${R},0 Z`;
  const rightPath = `M${lw},0 H${W - R} Q${W},0 ${W},${R} V${H - R} Q${W},${H} ${W - R},${H} H${lw} Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" role="img" aria-label="ashlr token savings badge">
  <title>ashlr · ${rightText}</title>
  ${shieldGradients()}
  <clipPath id="r"><path d="${clip}"/></clipPath>
  <g clip-path="url(#r)">
    <path d="${leftPath}"  fill="${BRAND}"/>
    <path d="${rightPath}" fill="${GREY}"/>
    <rect width="${W}" height="${H}" fill="url(#s)"/>
  </g>
  <text x="${lw / 2}" y="14" font-family="${FONT}" font-size="11" fill="${WHITE}" text-anchor="middle">${leftText}</text>
  <text x="${lw + rw / 2}" y="14" font-family="${FONT}" font-size="11" fill="${WHITE}" text-anchor="middle">${rightText}</text>
</svg>`;
}

function buildCard(leftText: string, rightText: string, data: BadgeData): string {
  const W = 240;
  const H = 80;
  const R = 6;

  const days    = Object.entries(data.byDay).sort(([a], [b]) => a.localeCompare(b)).slice(-7);
  const maxVal  = Math.max(1, ...days.map(([, v]) => v));
  const barW    = 10;
  const barGap  = 3;
  const chartH  = 20;
  const chartX  = W - (days.length * (barW + barGap)) - 16;
  const chartY  = H - chartH - 12;

  const bars = days.map(([, v], i) => {
    const bh = Math.max(2, Math.round((v / maxVal) * chartH));
    const x  = chartX + i * (barW + barGap);
    const y  = chartY + chartH - bh;
    return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="2" fill="${BRAND}" opacity="0.85"/>`;
  }).join("\n    ");

  const clip = `M${R},0 H${W - R} Q${W},0 ${W},${R} V${H - R} Q${W},${H} ${W - R},${H} H${R} Q0,${H} 0,${H - R} V${R} Q0,0 ${R},0 Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" role="img" aria-label="ashlr token savings card">
  <title>ashlr · ${rightText}</title>
  <defs>
    <clipPath id="cr"><path d="${clip}"/></clipPath>
  </defs>
  <g clip-path="url(#cr)">
    <rect width="${W}" height="28" fill="${BRAND}"/>
    <rect y="28" width="${W}" height="${H - 28}" fill="#2d3748"/>
  </g>
  <text x="12" y="18" font-family="${FONT}" font-size="12" font-weight="600" fill="${WHITE}">${leftText}</text>
  <text x="12" y="48" font-family="${FONT}" font-size="18" font-weight="700" fill="${WHITE}">${rightText}</text>
  ${bars.length ? bars : ""}
</svg>`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function generateBadgeSvg(
  data: BadgeData | null,
  opts: BadgeOptions,
): string {
  const hasData  = data !== null && data.calls > 0;
  const safeData = data ?? { tokens: 0, calls: 0, byDay: {} };

  const leftText  = "ashlr";
  const rightText = rightLabel(safeData, opts.metric, hasData);

  switch (opts.style) {
    case "flat": return buildFlat(leftText, rightText);
    case "card": return buildCard(leftText, rightText, safeData);
    default:     return buildPill(leftText, rightText);
  }
}
