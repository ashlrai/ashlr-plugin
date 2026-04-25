#!/usr/bin/env bun
/**
 * ashlr savings dashboard — rich CLI view.
 *
 * Reads ~/.ashlr/stats.json and renders a multi-panel dashboard:
 *   - ASCII-art banner (3 lines, block chars, ≤70 cols)
 *   - "At a glance" tile strip (session / lifetime / best day)
 *   - Per-tool horizontal bar chart (top 8 tools, Unicode block bars)
 *   - 7-day + 30-day sparklines (labeled, capped at 20 cells)
 *   - Projected annual savings (extrapolated from last 30d)
 *   - Top 3 projects (from ~/.ashlr/session-log.jsonl)
 *
 * Uses ANSI truecolor only when COLORTERM=truecolor/24bit and NO_COLOR is
 * unset. Falls back to plain text with identical visible column widths.
 *
 * --watch flag: clear + redraw every 1.5s. Exits on Ctrl-C.
 * Skipped (single render) when process.stdin.isTTY === false.
 *
 * Contract: always exit 0. No external dependencies.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { buildTopProjects, renderNudgeSection } from "./savings-report-extras.ts";
import { readHookTimings, renderCompact } from "./hook-timings-report.ts";
import { readNudgeSummarySync } from "../servers/_nudge-events.ts";
import { costFor as _costFor, pricing as _pricing, pricingModel as _pricingModel } from "../servers/_pricing.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PerTool {
  calls?: number;
  tokensSaved?: number;
}
interface ByTool {
  [k: string]: PerTool | undefined;
}
interface PerDay {
  calls?: number;
  tokensSaved?: number;
}
interface ByDay {
  [date: string]: PerDay | undefined;
}
interface ByProject {
  [path: string]: { calls?: number; tokensSaved?: number } | undefined;
}

interface SessionStats {
  startedAt?: string;
  calls?: number;
  tokensSaved?: number;
  byTool?: ByTool;
  byProject?: ByProject;
}
interface LifetimeStats {
  calls?: number;
  tokensSaved?: number;
  /** v1.18: denominator for % savings. Missing from older stats.json → treat as 0. */
  rawTotal?: number;
  byTool?: ByTool;
  byDay?: ByDay;
  byProject?: ByProject;
}
interface Stats {
  session?: SessionStats;
  lifetime?: LifetimeStats;
}

// ---------------------------------------------------------------------------
// Color / ANSI — truecolor when COLORTERM advertises it; plain fallback
// ---------------------------------------------------------------------------

const TRUECOLOR = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === "3" || process.env.FORCE_COLOR === "true") return true;
  const ct = (process.env.COLORTERM ?? "").toLowerCase();
  return ct === "truecolor" || ct === "24bit";
})();

// Brand palette: green family for primary, slate for structural chrome
const RGB = {
  brand:     [0,   208, 156] as const,  // #00d09c  primary brand green
  brandDim:  [0,   140, 100] as const,  // dimmer brand green
  brandBold: [124, 255, 214] as const,  // #7cffd6  bright highlight
  gold:      [220, 180,  50] as const,  // #dcb432  numbers / values
  slate:     [120, 130, 145] as const,  // structural chrome
  white:     [220, 225, 235] as const,  // labels
  red:       [225,  91,  91] as const,  // errors
  blue:      [ 90, 160, 230] as const,  // low-intensity bars
  cyan:      [ 60, 200, 220] as const,  // mid-intensity bars
};

type RGBTriple = readonly [number, number, number];

function tc(rgb: RGBTriple, s: string): string {
  if (!TRUECOLOR) return s;
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[0m`;
}
function bold(s: string): string {
  if (!TRUECOLOR) return s;
  return `\x1b[1m${s}\x1b[22m`;
}
function dim(s: string): string {
  if (!TRUECOLOR) return s;
  return `\x1b[2m${s}\x1b[22m`;
}

// ---------------------------------------------------------------------------
// Visible-width helpers — strip ANSI before measuring
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function visibleWidth(s: string): number {
  return Array.from(s.replace(ANSI_RE, "")).length;
}

function padEnd(s: string, w: number, ch = " "): string {
  const pad = w - visibleWidth(s);
  return pad > 0 ? s + ch.repeat(pad) : s;
}

function padStart(s: string, w: number, ch = " "): string {
  const pad = w - visibleWidth(s);
  return pad > 0 ? ch.repeat(pad) + s : s;
}

// ---------------------------------------------------------------------------
// Number formatters
// ---------------------------------------------------------------------------

/**
 * v1.18: unified pricing via `../servers/_pricing.ts` — same token count
 * produces the same dollar value here as in the efficiency-server's
 * `renderSavings()`. Prior $5 "blended" value is replaced by the model-
 * specific input rate (sonnet-4.5 default → $3/MTok).
 */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(Math.floor(n));
  if (n < 1_000_000) return (n / 1_000).toFixed(1) + "K";
  return (n / 1_000_000).toFixed(2) + "M";
}

export function fmtUsd(tokens: number): string {
  const cost = _costFor(tokens);
  if (cost < 0.01) return `~$${cost.toFixed(4)}`;
  if (cost < 1) return `~$${cost.toFixed(3)}`;
  if (cost < 100) return `~$${cost.toFixed(2)}`;
  return `~$${Math.round(cost).toLocaleString()}`;
}

function fmtAge(iso: string | undefined): string {
  if (!iso) return "unknown";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "unknown";
  const ms = Date.now() - t;
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function lastNDayKeys(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function bestDay(byDay: ByDay): { date: string; tokens: number } | null {
  let best: { date: string; tokens: number } | null = null;
  for (const [date, v] of Object.entries(byDay)) {
    const tok = v?.tokensSaved ?? 0;
    if (!best || tok > best.tokens) best = { date, tokens: tok };
  }
  return best;
}

/**
 * UTC YYYY-MM-DD for `today` and `today - 1 day`.
 * Isolated into a helper so tests can inject a fixed `now`.
 */
export function todayYesterdayKeys(now: Date = new Date()): { today: string; yesterday: string } {
  const todayDate = new Date(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  return {
    today: todayDate.toISOString().slice(0, 10),
    yesterday: yesterdayDate.toISOString().slice(0, 10),
  };
}

/**
 * Today-vs-yesterday one-liner.
 *
 * Render rules (from the v1.18.1 brief):
 *   - todaySaved === 0                          → "" (silent; nothing to celebrate)
 *   - yesterdaySaved === 0 && todaySaved > 0    → "Saved X tokens today — great start!"
 *   - ratio >= 1.1                              → "Today's pace is N.Nx yesterday's (X vs Y tokens)"
 *   - ratio <= 0.5                              → "Today's saved fewer than yesterday (X vs Y — less active session?)"
 *   - otherwise                                 → "" (quiet; numbers are similar)
 *
 * Returns an already-colored line (single line, no trailing newline). Returns
 * "" when the callout should not render.
 */
export function renderTodayVsYesterday(
  byDay: ByDay,
  now: Date = new Date(),
): string {
  const { today, yesterday } = todayYesterdayKeys(now);
  const todaySaved = byDay[today]?.tokensSaved ?? 0;
  const yesterdaySaved = byDay[yesterday]?.tokensSaved ?? 0;

  if (todaySaved === 0) return "";

  if (yesterdaySaved === 0) {
    // Great-start case — today is nonzero, yesterday was silent.
    return (
      "  " +
      tc(RGB.brandBold, bold(`Saved ${fmtTokens(todaySaved)} tokens today`)) +
      tc(RGB.brand, " — great start!")
    );
  }

  const ratio = todaySaved / yesterdaySaved;

  if (ratio >= 1.1) {
    return (
      "  " +
      tc(RGB.brand, bold(`Today's pace is ${ratio.toFixed(1)}x yesterday's`)) +
      tc(RGB.slate, dim(` (${fmtTokens(todaySaved)} vs ${fmtTokens(yesterdaySaved)} tokens)`))
    );
  }

  if (ratio <= 0.5) {
    return (
      "  " +
      tc(RGB.gold, "Today's saved fewer than yesterday") +
      tc(RGB.slate, dim(` (${fmtTokens(todaySaved)} vs ${fmtTokens(yesterdaySaved)} — less active session?)`))
    );
  }

  // Quiet zone — numbers are similar. No callout.
  return "";
}

// ---------------------------------------------------------------------------
// Stats loading
// ---------------------------------------------------------------------------

export const STATS_PATH = join(homedir(), ".ashlr", "stats.json");

export function loadStats(path = STATS_PATH): Stats | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Stats;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dashboard width budget
// ---------------------------------------------------------------------------

// All content must fit in 80 visible columns.
export const DASH_WIDTH = 78; // outer box spans 80 cols (border chars included)
const INNER = DASH_WIDTH - 2;  // inner content width

// ---------------------------------------------------------------------------
// ASCII-art banner — block/shade chars, 3 lines, ≤70 cols
// ---------------------------------------------------------------------------

// Compact "ashlr" banner — built manually to stay within 70 cols
// a  s  h  l  r   (5 chars × ~13 cols + spacing ≈ 68 cols total)
// Editorial bracket-frame wordmark — the prior 3-line block-letter art
// rendered as garbled glyphs that didn't read as "ashlr". This replacement
// reads cleanly, matches the SAVINGS_BANNER design language, and sits well
// between the top/bottom slate rules + the dimmed TAGLINE.
const BANNER: string[] = [
  "  ╭─ ashlr · dashboard",
  "  │  ─────",
];

// Tagline under banner
const TAGLINE = "  token-efficiency layer for claude code";

function renderBanner(): string[] {
  const lines: string[] = [];
  // Top rule
  lines.push(tc(RGB.slate, "─".repeat(DASH_WIDTH)));
  for (const line of BANNER) {
    lines.push(tc(RGB.brandBold, bold(line)));
  }
  lines.push(tc(RGB.brandDim, TAGLINE));
  lines.push(tc(RGB.slate, "─".repeat(DASH_WIDTH)));
  return lines;
}

// ---------------------------------------------------------------------------
// Box drawing helpers
// ---------------------------------------------------------------------------

function boxTop(title: string, width: number): string {
  const inner = width - 2;
  const titleStr = ` ${title} `;
  const titleLen = visibleWidth(titleStr);
  const dashes = Math.max(0, inner - titleLen);
  const l = Math.floor(dashes / 2);
  const r = dashes - l;
  return tc(RGB.slate, "╭" + "─".repeat(l)) +
    tc(RGB.brandBold, bold(titleStr)) +
    tc(RGB.slate, "─".repeat(r) + "╮");
}

function boxBottom(width: number): string {
  return tc(RGB.slate, "╰" + "─".repeat(width - 2) + "╯");
}

function boxLine(content: string, width: number): string {
  const inner = width - 2;
  const padded = padEnd(" " + content, inner);
  return tc(RGB.slate, "│") + padded + tc(RGB.slate, "│");
}

function boxEmpty(width: number): string {
  return tc(RGB.slate, "│") + " ".repeat(width - 2) + tc(RGB.slate, "│");
}

// ---------------------------------------------------------------------------
// "At a glance" tile strip
// 3 tiles side by side, total width ≤ 78
// Each tile: 24 cols wide (22 inner + 2 border), gap = 1 space
// 3 × 24 + 2 gaps = 74. Center-padding to 78: 2 each side → fine.
// ---------------------------------------------------------------------------

const TILE_W = 24; // total tile width including border chars

function renderTileStrip(stats: Stats): string[] {
  const sess = stats.session;
  const life = stats.lifetime;
  const bd = bestDay(life?.byDay ?? {});

  const tiles: Array<{ title: string; line1: string; line2: string }> = [
    {
      title: "session",
      line1: tc(RGB.brandBold, bold(fmtTokens(sess?.tokensSaved ?? 0))),
      line2: tc(RGB.gold, fmtUsd(sess?.tokensSaved ?? 0)) +
             tc(RGB.slate, dim(`  ${fmtAge(sess?.startedAt)}`)),
    },
    {
      title: "lifetime",
      line1: tc(RGB.brandBold, bold(fmtTokens(life?.tokensSaved ?? 0))),
      line2: tc(RGB.gold, fmtUsd(life?.tokensSaved ?? 0)) +
             tc(RGB.slate, dim(`  ${life?.calls ?? 0} calls`)),
    },
    {
      title: "best day",
      line1: tc(RGB.white, bd?.date ?? "none yet"),
      line2: bd
        ? tc(RGB.brandBold, bold(fmtTokens(bd.tokens))) + tc(RGB.slate, dim(" tok"))
        : tc(RGB.slate, dim("no data")),
    },
  ];

  // Each tile has 3 rows: top, line1, line2, bottom
  const rows: string[][] = tiles.map(({ title, line1, line2 }) => [
    boxTop(title, TILE_W),
    boxLine(line1, TILE_W),
    boxLine(line2, TILE_W),
    boxBottom(TILE_W),
  ]);

  const out: string[] = [];
  // Render row by row (interleave the 3 tiles)
  for (let r = 0; r < rows[0]!.length; r++) {
    out.push(rows.map((tile) => tile[r]).join("  "));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-tool horizontal bar chart
// Top 8 tools sorted by lifetime tokensSaved descending.
// Bar width: 24 cols. Line format:
//   <name padded 16>  <bar 24>  <tok 6>  <pct 4>
//   = 16 + 2 + 24 + 2 + 6 + 2 + 4 = 56 chars (fits in 78)
// ---------------------------------------------------------------------------

const BAR_WIDTH = 24;
const BLOCK_CHARS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

function hBar(value: number, max: number, width: number): string {
  if (max <= 0 || width <= 0) return " ".repeat(width);
  const fraction = Math.max(0, Math.min(1, value / max));
  const totalEighths = Math.round(fraction * width * 8);
  const fullCells = Math.floor(totalEighths / 8);
  const remainder = totalEighths % 8;

  let bar = "";
  // Color by fill level — low blue, mid cyan, high brand green
  const fillLevel = fraction;
  const barColor = fillLevel >= 0.7
    ? RGB.brand
    : fillLevel >= 0.35
    ? RGB.cyan
    : RGB.blue;

  for (let i = 0; i < fullCells; i++) {
    bar += tc(barColor, "█");
  }
  if (remainder > 0 && fullCells < width) {
    bar += tc(barColor, BLOCK_CHARS[remainder - 1]!);
    // Fill remainder with dim empty
    bar += tc(RGB.slate, dim("░".repeat(width - fullCells - 1)));
  } else if (fullCells < width) {
    bar += tc(RGB.slate, dim("░".repeat(width - fullCells)));
  }
  return bar;
}

function renderBarChart(stats: Stats): string[] {
  const out: string[] = [];
  out.push("");
  out.push(tc(RGB.brand, bold("  per-tool savings (lifetime)")));
  out.push("");

  const byTool = stats.lifetime?.byTool ?? {};
  const rows = Object.entries(byTool)
    .map(([name, t]) => ({
      name,
      calls: t?.calls ?? 0,
      tokensSaved: t?.tokensSaved ?? 0,
    }))
    .filter((r) => r.tokensSaved > 0)
    .sort((a, b) => b.tokensSaved - a.tokensSaved)
    .slice(0, 8);

  if (rows.length === 0) {
    out.push(tc(RGB.gold, "  no tool usage recorded yet."));
    return out;
  }

  const maxTok = Math.max(...rows.map((r) => r.tokensSaved));
  const total = rows.reduce((s, r) => s + r.tokensSaved, 0);

  for (const r of rows) {
    // Layout: indent(2) + name(16) + sp(2) + bar(24) + sp(2) + tok(7) + sp(1) + pct(4) = 58
    const name = padEnd(tc(RGB.white, r.name), 16);
    const bar = hBar(r.tokensSaved, maxTok, BAR_WIDTH);
    const tok = padStart(tc(RGB.brandBold, fmtTokens(r.tokensSaved)), 7);
    const pct = padStart(
      tc(RGB.slate, dim(Math.round((r.tokensSaved / total) * 100) + "%")),
      4,
    );
    out.push(`  ${name}  ${bar}  ${tok} ${pct}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sparklines — 7d and 30d
// One Unicode block char per day, capped at 20 cells, labeled.
// ---------------------------------------------------------------------------

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function sparkGlyph(value: number, max: number): string {
  if (value <= 0 || max <= 0) return tc(RGB.slate, dim("▁"));
  const idx = Math.max(0, Math.min(7, Math.ceil((value / max) * 7) - 1));
  const fraction = value / max;
  const color = fraction >= 0.7 ? RGB.brand : fraction >= 0.35 ? RGB.cyan : RGB.blue;
  return tc(color, SPARK_CHARS[idx]!);
}

function renderSparklines(stats: Stats): string[] {
  const byDay = stats.lifetime?.byDay ?? {};
  const out: string[] = [];
  out.push("");
  out.push(tc(RGB.brand, bold("  activity sparklines")));
  out.push("");

  const MAX_CELLS = 20;

  for (const [days, label] of [[7, "last 7d "], [30, "last 30d"]] as Array<[number, string]>) {
    const keys = lastNDayKeys(days);
    const values = keys.map((k) => byDay[k]?.tokensSaved ?? 0);
    // Truncate to MAX_CELLS (30d → 20 cells, every 1.5th day; 7d fits fine)
    const step = days > MAX_CELLS ? days / MAX_CELLS : 1;
    const sampled: number[] = [];
    if (step > 1) {
      // Average buckets for 30d → 20 cells
      const cellCount = MAX_CELLS;
      for (let i = 0; i < cellCount; i++) {
        const start = Math.floor(i * step);
        const end = Math.min(values.length, Math.floor((i + 1) * step));
        const bucket = values.slice(start, end);
        sampled.push(bucket.reduce((s, v) => s + v, 0));
      }
    } else {
      sampled.push(...values);
    }

    const max = Math.max(...sampled);
    const spark = sampled.map((v) => sparkGlyph(v, max)).join("");
    const totalTok = values.reduce((s, v) => s + v, 0);
    const activeDays = values.filter((v) => v > 0).length;
    const suffix =
      max > 0
        ? tc(RGB.slate, dim(`  total ${fmtTokens(totalTok)}  active ${activeDays}/${days}d`))
        : tc(RGB.slate, dim("  no data"));

    out.push(
      `  ${tc(RGB.white, label)}  ${spark}${suffix}`,
    );

    // Peak annotation on busiest day (7d only — 30d too wide)
    if (days === 7 && max > 0) {
      const peakIdx = values.indexOf(max);
      const peakDate = keys[peakIdx] ?? "";
      out.push(
        `           ${" ".repeat(peakIdx)}${tc(RGB.gold, "^")}  ${tc(RGB.slate, dim(`peak ${peakDate.slice(5)} (${fmtTokens(max)})`))}`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Projected annual
// ---------------------------------------------------------------------------

function renderProjection(stats: Stats): string[] {
  const byDay = stats.lifetime?.byDay ?? {};
  const keys = lastNDayKeys(30);
  const values = keys.map((k) => byDay[k]?.tokensSaved ?? 0);
  const activeDays = values.filter((v) => v > 0).length;
  const total = values.reduce((s, v) => s + v, 0);

  const out: string[] = [];
  out.push("");
  out.push(tc(RGB.brand, bold("  projected annual savings")));
  out.push("");

  if (activeDays < 3 || total === 0) {
    out.push(tc(RGB.gold, `  not enough history — projection unlocks after ≥3 active days.`));
    out.push(tc(RGB.slate, dim(`  currently tracking ${activeDays} active day(s) in the last 30.`)));
    return out;
  }

  const annualTokens = Math.round((total * 365) / 30);
  const annualCost = fmtUsd(annualTokens);
  const annualCalls = Math.round(((stats.lifetime?.calls ?? 0) / Math.max(1, activeDays)) * 220);

  // Active-day workday extrapolation
  const perActive = total / activeDays;
  const workdayTokens = Math.round(perActive * 220);
  const workdayCost = fmtUsd(workdayTokens);

  const colL = 22;
  const col1 = 10;
  const col2 = 12;

  out.push(
    padEnd(tc(RGB.slate, dim("  30d rolling × 12")), colL) +
    padStart(tc(RGB.brandBold, bold(fmtTokens(annualTokens))), col1) +
    " tok/yr  " +
    tc(RGB.gold, annualCost),
  );
  out.push(
    padEnd(tc(RGB.slate, dim("  active-day × 220")), colL) +
    padStart(tc(RGB.brandBold, bold(fmtTokens(workdayTokens))), col1) +
    " tok/yr  " +
    tc(RGB.gold, workdayCost),
  );
  out.push(
    padEnd(tc(RGB.slate, dim("  calls extrapolation")), colL) +
    padStart(tc(RGB.white, String(annualCalls)), col1) +
    " calls/yr",
  );
  out.push("");
  out.push(tc(RGB.slate, dim("  projection based on last 30d average — may vary.")));

  return out;
}

// ---------------------------------------------------------------------------
// Top 3 projects (from session-log.jsonl)
// ---------------------------------------------------------------------------

function renderTopProjects(statsHome?: string): string[] {
  const projects = buildTopProjects(statsHome).slice(0, 3);
  const out: string[] = [];
  if (projects.length === 0) return out;

  out.push("");
  out.push(tc(RGB.brand, bold("  top projects")));
  out.push("");

  const maxCalls = Math.max(...projects.map((p) => p.calls));
  for (const [i, p] of projects.entries()) {
    // Layout: indent(2) + rank(2) + sp(1) + name(24) + sp(1) + calls(5) + "x  "(3) + bar(12) + tools(8) = 58
    const name = p.name.length > 24 ? "..." + p.name.slice(-21) : p.name;
    const rankStr = padEnd(tc(RGB.slate, dim(`${i + 1}.`)), 2);
    const nameStr = padEnd(tc(RGB.white, name), 24);
    const callsStr = padStart(tc(RGB.brandBold, String(p.calls)), 5);
    const miniBar = hBar(p.calls, maxCalls, 12);
    const toolStr = tc(RGB.slate, dim(` ${p.toolVariety} tool${p.toolVariety === 1 ? "" : "s"}`));
    out.push(`  ${rankStr} ${nameStr} ${callsStr}x  ${miniBar}${toolStr}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Empty stats fallback
// ---------------------------------------------------------------------------

function renderNoData(): string {
  const lines: string[] = [];
  lines.push(...renderBanner());
  lines.push("");
  lines.push(
    tc(RGB.gold,
      "  no savings recorded yet — run /ashlr-demo to see the plugin in action."
    )
  );
  lines.push("");
  lines.push(tc(RGB.slate, dim(`  stats path: ${STATS_PATH}`)));
  lines.push(tc(RGB.slate, dim("  use ashlr__read, ashlr__grep, or ashlr__edit to start.")));
  lines.push("");
  lines.push(tc(RGB.slate, "─".repeat(DASH_WIDTH)));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Divider helper
// ---------------------------------------------------------------------------

function divider(label?: string): string {
  if (!label) return tc(RGB.slate, dim("  " + "·".repeat(DASH_WIDTH - 2)));
  const inner = label;
  const dashes = Math.max(4, DASH_WIDTH - visibleWidth(inner) - 4);
  return tc(RGB.slate, dim("  ")) + tc(RGB.slate, inner) + tc(RGB.slate, dim(" " + "·".repeat(dashes)));
}

// ---------------------------------------------------------------------------
// Top-level renderer
// ---------------------------------------------------------------------------

function renderHookPerformance(statsHome?: string): string[] {
  try {
    const timingsPath = join(statsHome ?? join(homedir(), ".ashlr"), "hook-timings.jsonl");
    const records = readHookTimings(timingsPath);
    if (records.length === 0) return [];
    const compact = renderCompact({ records, topN: 5, windowHours: 24 });
    if (!compact) return [];
    const out: string[] = [];
    out.push("");
    out.push(tc(RGB.brand, bold("  hook performance (last 24h)")));
    out.push("");
    for (const line of compact.split("\n").slice(1)) { // skip redundant header line
      out.push(`  ${line}`);
    }
    return out;
  } catch {
    return [];
  }
}

function renderNudge(home?: string): string[] {
  try {
    const h = home ?? process.env.HOME ?? homedir();
    const proUser = existsSync(join(h, ".ashlr", "pro-token"));
    const summary = readNudgeSummarySync(h);
    const block = renderNudgeSection(summary, proUser);
    if (!block) return [];
    const out: string[] = [""];
    for (const line of block.split("\n")) out.push(`  ${line}`);
    return out;
  } catch {
    return [];
  }
}

export function render(stats: Stats | null, statsHome?: string): string {
  if (!stats) return renderNoData();

  const parts: string[] = [];
  parts.push(...renderBanner());
  parts.push("");
  // Today-vs-yesterday one-liner — lives directly below the banner so it's the
  // first data point the eye catches, above the tile strip and per-tool bars.
  // Renders "" (and is therefore filtered out) when the numbers are quiet.
  const tvy = renderTodayVsYesterday(stats.lifetime?.byDay ?? {});
  if (tvy) {
    parts.push(tvy);
    parts.push("");
  }
  parts.push(...renderTileStrip(stats));
  parts.push(...renderBarChart(stats));
  parts.push(divider());
  parts.push(...renderSparklines(stats));
  parts.push(divider());
  parts.push(...renderProjection(stats));
  parts.push(divider());
  parts.push(...renderTopProjects(statsHome));
  const hookPerf = renderHookPerformance(statsHome);
  if (hookPerf.length > 0) {
    parts.push(divider());
    parts.push(...hookPerf);
  }
  const nudge = renderNudge(statsHome);
  if (nudge.length > 0) {
    parts.push(divider());
    parts.push(...nudge);
  }
  parts.push("");
  const priceNow = _pricing();
  const modelNow = _pricingModel();
  // v1.18 ratio line: `saved / rawTotal` — only shown when rawTotal > 0.
  // Legacy stats.json files lack `rawTotal`; we surface "—" rather than a
  // fake 100% so the user sees the fix honestly.
  const life = stats.lifetime;
  const rawTot = life?.rawTotal ?? 0;
  const savedTot = life?.tokensSaved ?? 0;
  const ratioStr = rawTot > 0
    ? `${Math.round((savedTot / rawTot) * 100)}%`
    : "—";
  // Keep this footer ≤ 80 visible cols. Abbreviate STATS_PATH to ~/.ashlr/...
  // when it lives under $HOME so long home-dir paths don't blow the budget.
  const h = process.env.HOME ?? homedir();
  const shortPath = STATS_PATH.startsWith(h) ? "~" + STATS_PATH.slice(h.length) : STATS_PATH;
  parts.push(tc(RGB.slate, dim(
    `  ${shortPath} · ${modelNow} $${priceNow.inUsd}/M · saved/raw ${ratioStr}`,
  )));
  parts.push(tc(RGB.slate, "─".repeat(DASH_WIDTH)));

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Handoff mode — context-pack a fresh session can ingest cold
// ---------------------------------------------------------------------------

/**
 * Plain-text context-pack designed to be pasted into a fresh Claude Code
 * session so the next agent can resume with full context. No ANSI; ASCII
 * tables only. Intentionally short (~30 lines) so a human can scan it
 * quickly before pasting.
 */
export function renderHandoff(stats: Stats | null, opts: { cwd?: string; statsHome?: string } = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  const lines: string[] = [];

  lines.push("# ashlr handoff — paste into next session for cold-start context");
  lines.push("");
  lines.push(`Generated:   ${new Date().toISOString()}`);
  lines.push(`Working dir: ${cwd}`);

  // --- Git state (best-effort; per-command failures are swallowed) ---------
  // Cap stdout buffer at 4 MB so a `git status --porcelain` against a repo
  // with thousands of untracked paths (e.g. an unignored node_modules) can't
  // throw ERR_CHILD_PROCESS_STDIO_MAXBUFFER and wipe the partial state we'd
  // already printed.
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 4 * 1024 * 1024,
      }).toString().trim();
    } catch {
      return "";
    }
  };
  const branch = run("git rev-parse --abbrev-ref HEAD");
  const dirty = run("git status --porcelain").split("\n").filter(Boolean).length;
  const last5 = run("git log --oneline -5");
  if (branch) {
    lines.push(`Branch:      ${branch}${dirty > 0 ? `  (${dirty} uncommitted file${dirty === 1 ? "" : "s"})` : ""}`);
  }
  if (last5) {
    lines.push("");
    lines.push("Recent commits:");
    for (const l of last5.split("\n")) lines.push(`  ${l}`);
  }

  // --- Genome state --------------------------------------------------------
  const genomePath = join(cwd, ".ashlrcode", "genome");
  lines.push("");
  lines.push(`Genome:      ${existsSync(genomePath) ? "present at .ashlrcode/genome/" : "not initialized (/ashlr-genome-init to add)"}`);

  // --- Session activity (top tools + top projects) -------------------------
  if (stats?.session) {
    const calls = stats.session.calls ?? 0;
    const saved = stats.session.tokensSaved ?? 0;
    lines.push("");
    lines.push(`Session:     ${calls.toLocaleString()} call${calls === 1 ? "" : "s"} · ${saved.toLocaleString()} tokens saved`);

    const byTool = stats.session.byTool ?? {};
    const tools = Object.entries(byTool)
      .map(([name, v]) => ({ name, calls: v?.calls ?? 0, saved: v?.tokensSaved ?? 0 }))
      .filter((t) => t.calls > 0)
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 5);
    if (tools.length > 0) {
      lines.push("");
      lines.push("Top tools this session:");
      for (const t of tools) {
        lines.push(`  ${t.name.padEnd(24)} ${String(t.calls).padStart(5)} call${t.calls === 1 ? "" : "s"} · ${t.saved.toLocaleString()} saved`);
      }
    }
  }

  try {
    const projects = buildTopProjects(opts.statsHome).slice(0, 3);
    if (projects.length > 0) {
      lines.push("");
      lines.push("Top projects (recent):");
      for (const p of projects) {
        lines.push(
          `  ${p.name.padEnd(40)} ${p.calls.toLocaleString()} call${p.calls === 1 ? "" : "s"} · ${p.toolVariety} tool${p.toolVariety === 1 ? "" : "s"}`,
        );
      }
    }
  } catch {
    /* session-log absent or unreadable — skip silently */
  }

  lines.push("");
  lines.push("Tip: run /ashlr-savings or /ashlr-dashboard for the rich view.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Watch mode
// ---------------------------------------------------------------------------

const WATCH_INTERVAL_MS = 1500;

function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

async function watchMode(statsPath: string): Promise<void> {
  // Skip watch when not a TTY
  if (!process.stdin.isTTY) {
    const stats = loadStats(statsPath);
    process.stdout.write(render(stats) + "\n");
    return;
  }

  // Initial render
  clearScreen();
  process.stdout.write(render(loadStats(statsPath)) + "\n");

  const interval = setInterval(() => {
    clearScreen();
    process.stdout.write(render(loadStats(statsPath)) + "\n");
  }, WATCH_INTERVAL_MS);

  // Clean exit on Ctrl-C
  process.on("SIGINT", () => {
    clearInterval(interval);
    process.stdout.write("\n");
    process.exit(0);
  });

  // Also exit cleanly if stdin closes (non-interactive pipe)
  process.stdin.resume();
  process.stdin.on("close", () => {
    clearInterval(interval);
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const watch = process.argv.includes("--watch");
  const handoff = process.argv.includes("--handoff");
  try {
    if (handoff) {
      const stats = loadStats();
      process.stdout.write(renderHandoff(stats) + "\n");
    } else if (watch) {
      await watchMode(STATS_PATH);
    } else {
      const stats = loadStats();
      process.stdout.write(render(stats) + "\n");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(tc(RGB.red, "ashlr dashboard failed: ") + msg + "\n");
  }
  if (!watch) process.exit(0);
}
