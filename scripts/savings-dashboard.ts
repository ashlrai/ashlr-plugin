#!/usr/bin/env bun
/**
 * ashlr savings dashboard — rich CLI view.
 *
 * Reads ~/.ashlr/stats.json and renders a detailed multi-panel report:
 *   - Header: lifetime + session totals, cost in USD, session age
 *   - Session box: calls, tokens, capture ratio
 *   - By-tool bar chart (session + lifetime)
 *   - 7-day ASCII sparkline
 *   - 30-day ASCII sparkline + rollup
 *   - Top projects (if per-project data is present)
 *   - Projected annual savings (extrapolated from recent activity)
 *
 * Uses ANSI colors + Unicode box-drawing. No external deps.
 * Contract: always exit 0, render a graceful "no data yet" panel when
 * stats.json is absent or malformed.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
interface PerProject {
  calls?: number;
  tokensSaved?: number;
}
interface ByProject {
  [path: string]: PerProject | undefined;
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
  byTool?: ByTool;
  byDay?: ByDay;
  byProject?: ByProject;
}
interface Stats {
  session?: SessionStats;
  lifetime?: LifetimeStats;
}

// ---------------------------------------------------------------------------
// ANSI styling — a tiny zero-dep helper. Disables when NO_COLOR is set or
// stdout is not a TTY.
// ---------------------------------------------------------------------------

const COLOR_ENABLED = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  // Bun's process.stdout.isTTY is reliable; default to true when unknown so
  // that the dashboard still looks good when piped into Claude Code's code
  // block (which renders ANSI for terminals).
  return process.stdout.isTTY ?? true;
})();

function ansi(code: string, s: string): string {
  if (!COLOR_ENABLED) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const c = {
  dim: (s: string) => ansi("2", s),
  bold: (s: string) => ansi("1", s),
  cyan: (s: string) => ansi("36", s),
  brightCyan: (s: string) => ansi("96", s),
  green: (s: string) => ansi("32", s),
  brightGreen: (s: string) => ansi("92", s),
  yellow: (s: string) => ansi("33", s),
  brightYellow: (s: string) => ansi("93", s),
  magenta: (s: string) => ansi("35", s),
  brightMagenta: (s: string) => ansi("95", s),
  blue: (s: string) => ansi("34", s),
  brightBlue: (s: string) => ansi("94", s),
  red: (s: string) => ansi("31", s),
  white: (s: string) => ansi("97", s),
  gray: (s: string) => ansi("90", s),
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

// Blended Sonnet rate per spec: $3/M input, $15/M output. Assume blended $5/M
// for a rough but honest estimate — read-heavy workloads lean input-side.
const BLENDED_USD_PER_MTOK = 5;

function fmtUsd(tokens: number): string {
  const c = (tokens * BLENDED_USD_PER_MTOK) / 1_000_000;
  if (c < 0.01) return `$${c.toFixed(4)}`;
  if (c < 1) return `$${c.toFixed(3)}`;
  if (c < 100) return `$${c.toFixed(2)}`;
  return `$${Math.round(c).toLocaleString()}`;
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "K";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(2) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
}

function fmtAge(iso: string | undefined): string {
  if (!iso) return "unknown";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "unknown";
  const ms = Date.now() - t;
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

// Visual-width aware padding. ANSI escapes don't contribute to column width,
// so we strip them when measuring. Unicode box-drawing chars are single-width
// so plain .length works for non-ANSI text.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}
function padEndV(s: string, width: number): string {
  const pad = width - visibleLen(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}
function padStartV(s: string, width: number): string {
  const pad = width - visibleLen(s);
  return pad > 0 ? " ".repeat(pad) + s : s;
}

// ---------------------------------------------------------------------------
// Sparkline + bar chart
// ---------------------------------------------------------------------------

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max <= 0) return SPARK[0]!.repeat(values.length);
  return values
    .map((v) => {
      if (v <= 0) return c.gray(SPARK[0]!);
      const idx = Math.max(1, Math.min(7, Math.ceil((v / max) * 7)));
      // Color by intensity — low=blue, mid=cyan, high=green.
      const glyph = SPARK[idx]!;
      if (idx <= 2) return c.blue(glyph);
      if (idx <= 5) return c.cyan(glyph);
      return c.brightGreen(glyph);
    })
    .join("");
}

function hBar(value: number, max: number, width: number): string {
  if (max <= 0 || value <= 0 || width <= 0) return "";
  const filled = Math.max(1, Math.min(width, Math.round((value / max) * width)));
  const empty = width - filled;
  return c.brightCyan("█".repeat(filled)) + c.gray("░".repeat(empty));
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

// ---------------------------------------------------------------------------
// Stats loading
// ---------------------------------------------------------------------------

const STATS_PATH = join(homedir(), ".ashlr", "stats.json");

function loadStats(path = STATS_PATH): Stats | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Stats;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Panel rendering — each panel returns an array of already-padded lines plus
// its outer width. We stitch them together with the border routine below.
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 72;
const INNER = PANEL_WIDTH - 2; // subtract the two side borders

function panelTop(title: string): string {
  const raw = ` ${title} `;
  const dashes = PANEL_WIDTH - 2 - visibleLen(raw);
  const left = Math.max(2, Math.floor(dashes / 2));
  const right = Math.max(2, dashes - left);
  return (
    c.cyan("╔") +
    c.cyan("═".repeat(left)) +
    c.bold(c.brightCyan(raw)) +
    c.cyan("═".repeat(right)) +
    c.cyan("╗")
  );
}
function panelBottom(): string {
  return c.cyan("╚" + "═".repeat(PANEL_WIDTH - 2) + "╝");
}
function panelDivider(): string {
  return c.cyan("╟") + c.gray("─".repeat(PANEL_WIDTH - 2)) + c.cyan("╢");
}
function panelLine(content = ""): string {
  return c.cyan("║") + " " + padEndV(content, INNER - 2) + " " + c.cyan("║");
}
function panelEmpty(): string {
  return c.cyan("║") + " ".repeat(PANEL_WIDTH - 2) + c.cyan("║");
}

// ---------------------------------------------------------------------------
// Actual dashboard sections
// ---------------------------------------------------------------------------

function renderNoData(): string {
  const out: string[] = [];
  out.push(panelTop("ashlr savings dashboard"));
  out.push(panelEmpty());
  out.push(panelLine(c.yellow("No stats.json found yet.")));
  out.push(panelLine(c.dim(`Expected location: ${STATS_PATH}`)));
  out.push(panelEmpty());
  out.push(panelLine("Use the ashlr__read, ashlr__grep, and ashlr__edit"));
  out.push(panelLine("MCP tools in place of the built-ins to start"));
  out.push(panelLine("accumulating savings. This dashboard will light up"));
  out.push(panelLine("after your first few calls."));
  out.push(panelEmpty());
  out.push(panelLine(c.dim("Tip: /ashlr-tour runs a 60s guided demo.")));
  out.push(panelEmpty());
  out.push(panelBottom());
  return out.join("\n");
}

function renderHeader(stats: Stats): string[] {
  const life = stats.lifetime?.tokensSaved ?? 0;
  const sess = stats.session?.tokensSaved ?? 0;
  const lifeCost = fmtUsd(life);
  const sessCost = fmtUsd(sess);
  const age = fmtAge(stats.session?.startedAt);

  const out: string[] = [];
  out.push(panelTop("ashlr savings dashboard"));
  out.push(panelEmpty());
  // Two columns side by side — session left, lifetime right.
  const colW = Math.floor((INNER - 2) / 2);
  const headerL = c.bold(c.brightCyan("THIS SESSION")) + c.dim(`  ${age}`);
  const headerR = c.bold(c.brightMagenta("ALL-TIME"));
  const rowA = [
    c.dim("  tokens  ") + c.brightGreen(fmtTokens(sess)),
    c.dim("  tokens  ") + c.brightGreen(fmtTokens(life)),
  ];
  const rowB = [
    c.dim("  cost    ") + c.brightYellow(sessCost),
    c.dim("  cost    ") + c.brightYellow(lifeCost),
  ];
  const rowC = [
    c.dim("  calls   ") + c.white(String(stats.session?.calls ?? 0)),
    c.dim("  calls   ") + c.white(String(stats.lifetime?.calls ?? 0)),
  ];
  out.push(panelLine(padEndV(headerL, colW) + headerR));
  out.push(panelLine(padEndV(rowA[0]!, colW) + rowA[1]));
  out.push(panelLine(padEndV(rowB[0]!, colW) + rowB[1]));
  out.push(panelLine(padEndV(rowC[0]!, colW) + rowC[1]));
  out.push(panelEmpty());
  out.push(
    panelLine(
      c.dim("  blended $5/M-tok · sonnet-4.5 pricing: $3/M in, $15/M out"),
    ),
  );
  return out;
}

function renderSessionBox(stats: Stats): string[] {
  const sess = stats.session;
  const out: string[] = [];
  out.push(panelDivider());
  out.push(panelLine(c.bold(c.cyan("SESSION BREAKDOWN"))));
  out.push(panelEmpty());
  if (!sess || (sess.calls ?? 0) === 0) {
    out.push(panelLine(c.yellow("  No ashlr tool calls yet this session.")));
    out.push(panelLine(c.dim("  Try ashlr__read on any file to get started.")));
    return out;
  }

  // Capture ratio: what % of the lifetime total was earned in this session?
  // Meaningful for long-running sessions on fresh installs.
  const life = stats.lifetime?.tokensSaved ?? 0;
  const ratio = life > 0 ? (sess.tokensSaved ?? 0) / life : 0;
  const ratioStr = (ratio * 100).toFixed(1) + "%";

  out.push(
    panelLine(
      c.dim("  calls        ") +
        c.white(String(sess.calls ?? 0).padStart(8)) +
        "   " +
        c.dim("started  ") +
        c.white(fmtAge(sess.startedAt)),
    ),
  );
  out.push(
    panelLine(
      c.dim("  tokens       ") +
        c.brightGreen(fmtTokens(sess.tokensSaved ?? 0).padStart(8)) +
        "   " +
        c.dim("cost     ") +
        c.brightYellow(fmtUsd(sess.tokensSaved ?? 0)),
    ),
  );
  out.push(
    panelLine(
      c.dim("  % of all-time ") +
        c.brightCyan(ratioStr.padStart(7)) +
        "    " +
        c.gray("(share earned this session)"),
    ),
  );
  return out;
}

const TOOL_NAMES = [
  "ashlr__read",
  "ashlr__grep",
  "ashlr__edit",
  "ashlr__sql",
  "ashlr__bash",
  "ashlr__http",
  "ashlr__savings",
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

function renderByTool(stats: Stats): string[] {
  const out: string[] = [];
  out.push(panelDivider());
  out.push(panelLine(c.bold(c.cyan("BY TOOL") + c.dim("  (lifetime)"))));
  out.push(panelEmpty());

  const byTool = stats.lifetime?.byTool ?? {};
  // Include any tool key we see in the file, even if not in TOOL_NAMES — future-proofs
  // the dashboard when new tools are added to the efficiency server.
  const keys = new Set<string>([...TOOL_NAMES, ...Object.keys(byTool)]);
  const rows = Array.from(keys)
    .map((name) => {
      const t = byTool[name] ?? {};
      return {
        name,
        calls: t.calls ?? 0,
        tokensSaved: t.tokensSaved ?? 0,
      };
    })
    .filter((r) => r.calls > 0 || r.tokensSaved > 0)
    .sort((a, b) => b.tokensSaved - a.tokensSaved);

  if (rows.length === 0) {
    out.push(panelLine(c.yellow("  No tool usage recorded yet.")));
    return out;
  }

  const maxTok = Math.max(...rows.map((r) => r.tokensSaved), 1);
  const total = rows.reduce((s, r) => s + r.tokensSaved, 0);
  const barWidth = 20;

  for (const r of rows) {
    const name = c.white(r.name.padEnd(16));
    const calls = c.dim(`${r.calls}× `.padStart(6));
    const tok = c.brightGreen(fmtTokens(r.tokensSaved).padStart(7));
    const bar = hBar(r.tokensSaved, maxTok, barWidth);
    const pctStr =
      total > 0
        ? c.dim(` ${Math.round((r.tokensSaved / total) * 100)}%`.padStart(4))
        : "";
    out.push(panelLine(`  ${name}${calls}${tok}  ${bar}${pctStr}`));
  }
  return out;
}

function renderSparklineSection(
  stats: Stats,
  days: number,
  label: string,
): string[] {
  const out: string[] = [];
  out.push(panelDivider());
  out.push(
    panelLine(c.bold(c.cyan(label) + c.dim(`  (per-day tokens saved)`))),
  );
  out.push(panelEmpty());

  const byDay = stats.lifetime?.byDay ?? {};
  const keys = lastNDayKeys(days);
  const values = keys.map((k) => byDay[k]?.tokensSaved ?? 0);
  const max = Math.max(...values);
  const total = values.reduce((s, v) => s + v, 0);
  const activeDays = values.filter((v) => v > 0).length;
  const avg = activeDays > 0 ? total / activeDays : 0;
  const best = keys[values.indexOf(max)];

  // The sparkline itself — one glyph per day, with colors by intensity.
  const spark = sparkline(values);

  // Axis labels: show first + middle + last date to anchor the timeline
  // without cluttering a 30-day chart.
  const firstLbl = keys[0]!.slice(5);
  const lastLbl = keys[keys.length - 1]!.slice(5);
  const axis =
    c.dim(firstLbl) +
    " ".repeat(Math.max(1, days - firstLbl.length - lastLbl.length)) +
    c.dim(lastLbl);

  out.push(panelLine("  " + spark));
  out.push(panelLine("  " + axis));
  out.push(panelEmpty());
  out.push(
    panelLine(
      c.dim("  total    ") +
        c.brightGreen(fmtTokens(total).padStart(8)) +
        "   " +
        c.dim("avg/day  ") +
        c.white(fmtTokens(Math.round(avg))),
    ),
  );
  if (max > 0 && best) {
    out.push(
      panelLine(
        c.dim("  peak     ") +
          c.brightYellow(fmtTokens(max).padStart(8)) +
          "   " +
          c.dim("on       ") +
          c.white(best),
      ),
    );
  }
  out.push(
    panelLine(
      c.dim("  active   ") +
        c.white(`${activeDays}/${days}`.padStart(8)) +
        "   " +
        c.dim("days     "),
    ),
  );
  return out;
}

function renderTopProjects(stats: Stats): string[] {
  const byProject: ByProject = {
    ...(stats.lifetime?.byProject ?? {}),
  };
  // Merge session per-project if present so we don't miss fresh activity.
  if (stats.session?.byProject) {
    for (const [k, v] of Object.entries(stats.session.byProject)) {
      if (!v) continue;
      const existing = byProject[k] ?? { calls: 0, tokensSaved: 0 };
      byProject[k] = {
        calls: (existing.calls ?? 0) + (v.calls ?? 0),
        tokensSaved: (existing.tokensSaved ?? 0) + (v.tokensSaved ?? 0),
      };
    }
  }

  const entries = Object.entries(byProject)
    .map(([path, v]) => ({
      path,
      calls: v?.calls ?? 0,
      tokensSaved: v?.tokensSaved ?? 0,
    }))
    .filter((r) => r.tokensSaved > 0 || r.calls > 0)
    .sort((a, b) => b.tokensSaved - a.tokensSaved)
    .slice(0, 5);

  // If there's no per-project data, don't render the panel at all — the
  // efficiency server doesn't currently track this, so we don't want to
  // surface an empty section.
  if (entries.length === 0) return [];

  const out: string[] = [];
  out.push(panelDivider());
  out.push(panelLine(c.bold(c.cyan("TOP PROJECTS") + c.dim("  (lifetime)"))));
  out.push(panelEmpty());

  const max = Math.max(...entries.map((e) => e.tokensSaved), 1);
  for (const [i, e] of entries.entries()) {
    // Show just the basename + one parent, truncated. Full paths clutter.
    const parts = e.path.split("/");
    const shortPath =
      parts.length >= 2
        ? parts.slice(-2).join("/")
        : e.path;
    const truncated =
      shortPath.length > 28 ? "…" + shortPath.slice(-27) : shortPath;
    const rank = c.dim(`  ${i + 1}.`);
    const name = c.white(padEndV(truncated, 30));
    const tok = c.brightGreen(fmtTokens(e.tokensSaved).padStart(7));
    const bar = hBar(e.tokensSaved, max, 16);
    out.push(panelLine(`${rank} ${name} ${tok}  ${bar}`));
  }
  return out;
}

function renderProjection(stats: Stats): string[] {
  const byDay = stats.lifetime?.byDay ?? {};
  const keys = lastNDayKeys(30);
  const values = keys.map((k) => byDay[k]?.tokensSaved ?? 0);
  const activeDays = values.filter((v) => v > 0).length;
  const total = values.reduce((s, v) => s + v, 0);

  const out: string[] = [];
  out.push(panelDivider());
  out.push(panelLine(c.bold(c.cyan("PROJECTED ANNUAL"))));
  out.push(panelEmpty());

  // Require at least 3 active days in the last 30 before projecting — a
  // single burst day extrapolated out is misleading snake-oil. The
  // lookback-window length (30d) is also the denominator: projection is
  // total * (365 / 30) when we have enough density.
  if (activeDays < 3 || total === 0) {
    out.push(
      panelLine(
        c.yellow(
          "  Not enough history yet — projection unlocks after ≥3 active days.",
        ),
      ),
    );
    out.push(
      panelLine(
        c.dim(
          `  Currently tracking ${activeDays} active day(s) in the last 30.`,
        ),
      ),
    );
    return out;
  }

  const annualTokens = Math.round((total * 365) / 30);
  const annualCost = fmtUsd(annualTokens);

  // Also compute an "active-day rate" — tokens per active working day,
  // extrapolated across a 220-workday year. This is often the more honest
  // number for bursty workers.
  const perActive = total / activeDays;
  const workdayTokens = Math.round(perActive * 220);
  const workdayCost = fmtUsd(workdayTokens);

  out.push(
    panelLine(
      c.dim("  30d extrapolation   ") +
        c.brightGreen(fmtTokens(annualTokens).padStart(9)) +
        c.dim("  tokens/yr   ") +
        c.brightYellow(annualCost),
    ),
  );
  out.push(
    panelLine(
      c.dim("  active-day × 220    ") +
        c.brightGreen(fmtTokens(workdayTokens).padStart(9)) +
        c.dim("  tokens/yr   ") +
        c.brightYellow(workdayCost),
    ),
  );
  out.push(panelEmpty());
  out.push(
    panelLine(
      c.dim(
        "  extrapolation = recent trajectory × (365/30). Not a forecast —",
      ),
    ),
  );
  out.push(
    panelLine(
      c.dim("  just a yardstick for what today's rate would compound to."),
    ),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Top-level renderer
// ---------------------------------------------------------------------------

export function render(stats: Stats | null): string {
  if (!stats) return renderNoData();

  const parts: string[] = [];
  parts.push(...renderHeader(stats));
  parts.push(...renderSessionBox(stats));
  parts.push(...renderByTool(stats));
  parts.push(...renderSparklineSection(stats, 7, "LAST 7 DAYS"));
  parts.push(...renderSparklineSection(stats, 30, "LAST 30 DAYS"));
  parts.push(...renderTopProjects(stats));
  parts.push(...renderProjection(stats));
  parts.push(panelEmpty());
  parts.push(panelBottom());

  // Footer outside the panel — pricing + data source note.
  const footer = [
    "",
    c.dim(
      `data: ${STATS_PATH}  ·  blended $5/M-tok  ·  run /ashlr-savings for the text-only summary`,
    ),
  ].join("\n");

  return parts.join("\n") + "\n" + footer;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    const stats = loadStats();
    process.stdout.write(render(stats) + "\n");
  } catch (err) {
    // Guard: never crash the slash command. Surface the error and bail.
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      c.red("ashlr savings dashboard failed: ") + msg + "\n",
    );
  }
  process.exit(0);
}
