#!/usr/bin/env bun
/**
 * generate-badge.ts — emit a self-contained SVG stats badge for ashlr-plugin.
 *
 * Usage:
 *   bun run scripts/generate-badge.ts [options]
 *
 * Options:
 *   --metric tokens|dollars|calls   what the right cell shows (default: tokens)
 *   --style  flat|pill|card         shape variant (default: pill)
 *   --window lifetime|last30|last7  time window (default: lifetime)
 *   --out    <path>                 write to file instead of stdout
 *   --serve                         start badge-serve HTTP server on :7777
 */

import { writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

// Re-use the shared stats reader — never touch _stats.ts otherwise.
import { readStats } from "../servers/_stats.ts";
import type { StatsFile } from "../servers/_stats.ts";

// Duplicate the 4-line pricing helper rather than importing from the server
// binary (which wires up MCP transports on import).
export const PRICING: Record<string, { input: number; output: number }> = {
  "sonnet-4.5": { input: 3.0, output: 15.0 },
  "opus-4":     { input: 15.0, output: 75.0 },
  "haiku-4.5":  { input: 0.8, output: 4.0 },
};
export function costFor(tokens: number, model = "sonnet-4.5"): number {
  const p = PRICING[model] ?? PRICING["sonnet-4.5"]!;
  return (tokens * p.input) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Metric = "tokens" | "dollars" | "calls";
export type Style  = "flat" | "pill" | "card";
export type Window = "lifetime" | "last30" | "last7";

export interface BadgeOptions {
  metric: Metric;
  style:  Style;
  window: Window;
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

/** ISO date string for N days ago: YYYY-MM-DD */
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export interface BadgeData {
  tokens: number;
  calls:  number;
  /** byDay entries filtered to window, keys = YYYY-MM-DD */
  byDay:  Record<string, number>;
}

export function extractData(stats: StatsFile, window: Window): BadgeData {
  const lt = stats.lifetime;
  if (window === "lifetime") {
    return {
      tokens: lt.tokensSaved,
      calls:  lt.calls,
      byDay:  Object.fromEntries(
        Object.entries(lt.byDay).map(([d, v]) => [d, v.tokensSaved]),
      ),
    };
  }
  const cutoff = window === "last7" ? daysAgo(7) : daysAgo(30);
  let tokens = 0;
  let calls = 0;
  const byDay: Record<string, number> = {};
  for (const [d, v] of Object.entries(lt.byDay)) {
    if (d >= cutoff) {
      tokens += v.tokensSaved;
      calls  += v.calls;
      byDay[d] = v.tokensSaved;
    }
  }
  return { tokens, calls, byDay };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

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

export function rightLabel(data: BadgeData, metric: Metric, hasData: boolean, methodLabel?: string): string {
  if (!hasData) return "no data yet";
  const suffix = methodLabel ? `, ${methodLabel}` : "";
  switch (metric) {
    case "tokens":  return `saved ${fmtTokens(data.tokens)}${suffix}`;
    case "dollars": return `${fmtDollars(data.tokens)}${suffix}`;
    case "calls":   return fmtCalls(data.calls);
  }
}

// ---------------------------------------------------------------------------
// SVG geometry
// ---------------------------------------------------------------------------

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const BRAND  = "#00d09c";
const GREY   = "#4a5568";
const WHITE  = "#ffffff";
const SHADOW = "#00000026";  // 15% alpha black

// Approximate text width in the badge font at 11px (covers ASCII well enough)
function approxTextWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 32) continue;
    // Narrow chars
    if ("iIl|1.,;:!".includes(ch)) { w += 4; continue; }
    if ("mwMW".includes(ch))        { w += 9; continue; }
    w += 7;
  }
  return w;
}

// ---------------------------------------------------------------------------
// SVG builders
// ---------------------------------------------------------------------------

function gradientDefs(id: string, color: string): string {
  return `
  <linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0"   stop-color="${WHITE}"  stop-opacity="0.15"/>
    <stop offset="1"   stop-color="${BLACK_STOP}" stop-opacity="0.1"/>
  </linearGradient>`;
}
const BLACK_STOP = "#000000";

function shieldGradients(): string {
  return `<defs>
  <linearGradient id="s" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0"   stop-color="${WHITE}"      stop-opacity="0.1"/>
    <stop offset="1"   stop-color="${BLACK_STOP}" stop-opacity="0.1"/>
  </linearGradient>
</defs>`;
}

/** Flat badge — no border-radius, no gradient. */
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

/** Pill badge — shields.io-style with rounded corners and gradient overlay. */
function buildPill(leftText: string, rightText: string): string {
  const lw = approxTextWidth(leftText) + 20;
  const rw = approxTextWidth(rightText) + 20;
  const W  = lw + rw;
  const H  = 20;
  const R  = 4;

  // Clip path: full pill shape
  const clip = `M${R},0 H${W - R} Q${W},0 ${W},${R} V${H - R} Q${W},${H} ${W - R},${H} H${R} Q0,${H} 0,${H - R} V${R} Q0,0 ${R},0 Z`;
  // Left fill path (rounded on left only)
  const leftPath  = `M${R},0 H${lw} V${H} H${R} Q0,${H} 0,${H - R} V${R} Q0,0 ${R},0 Z`;
  // Right fill path (rounded on right only)
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

/** Card badge — 240×80, includes a mini per-day bar chart. */
function buildCard(leftText: string, rightText: string, data: BadgeData): string {
  const W = 240;
  const H = 80;
  const R = 6;

  // Mini bar chart from byDay (last 7 entries, sorted)
  const days = Object.entries(data.byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-7);
  const maxVal = Math.max(1, ...days.map(([, v]) => v));
  const barW   = 10;
  const barGap = 3;
  const chartH = 20;
  const chartX = W - (days.length * (barW + barGap)) - 16;
  const chartY = H - chartH - 12;

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
  stats: StatsFile | null,
  opts: BadgeOptions,
): string {
  const hasData = stats !== null && stats.lifetime.calls > 0;
  const data = stats
    ? extractData(stats, opts.window)
    : { tokens: 0, calls: 0, byDay: {} };

  // v1.34: include methodology label so badge consumers can see how savings were counted.
  const measuredCalls = stats?.lifetime?.measuredCalls ?? 0;
  const methodLabel = (opts.metric !== "calls" && hasData)
    ? (measuredCalls >= 10 ? "API-measured" : "est.")
    : undefined;

  const leftText  = "ashlr";
  const rightText = rightLabel(data, opts.metric, hasData, methodLabel);

  switch (opts.style) {
    case "flat": return buildFlat(leftText, rightText);
    case "card": return buildCard(leftText, rightText, data);
    default:     return buildPill(leftText, rightText);
  }
}

// ---------------------------------------------------------------------------
// Badge-serve HTTP server (--serve flag)
// ---------------------------------------------------------------------------

async function serveBadge(opts: BadgeOptions): Promise<void> {
  const port = 7777;
  Bun.serve({
    port,
    async fetch() {
      let stats: StatsFile | null = null;
      try { stats = await readStats(); } catch { /* missing file → placeholder */ }
      const svg = generateBadgeSvg(stats, opts);
      return new Response(svg, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "no-cache",
        },
      });
    },
  });
  console.error(`Badge server running at http://localhost:${port}/ashlr.svg`);
  // Keep alive
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  function flag<T extends string>(name: string, def: T, valid: T[]): T {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return def;
    const v = args[i + 1] as T;
    return valid.includes(v) ? v : def;
  }
  function strFlag(name: string): string | null {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? (args[i + 1] ?? null) : null;
  }

  const metric = flag<Metric>("metric", "tokens", ["tokens", "dollars", "calls"]);
  const style  = flag<Style>("style",  "pill",    ["flat", "pill", "card"]);
  const window = flag<Window>("window", "lifetime", ["lifetime", "last30", "last7"]);
  const out    = strFlag("out");
  const serve  = args.includes("--serve");

  const opts: BadgeOptions = { metric, style, window };

  if (serve) {
    await serveBadge(opts);
    return;
  }

  let stats: StatsFile | null = null;
  try {
    stats = await readStats();
  } catch {
    // Missing stats file → placeholder badge
  }

  const svg = generateBadgeSvg(stats, opts);

  if (out) {
    await writeFile(out, svg, "utf8");
    console.error(`Badge written to ${out}`);
  } else {
    process.stdout.write(svg + "\n");
  }
}

if (import.meta.main) {
  await main();
}
