/** Savings report rendering and the public pricing compatibility table. */
import { type LifetimeBucket, type SessionBucket } from "./_stats";
import {
  renderPerProjectSection,
  renderBestDaySection,
  renderCalibrationLine,
  renderNudgeSection,
  renderProUpsellHint,
  type ExtraContext,
} from "../scripts/savings-report-extras";
// Shared with /ashlr-dashboard so the two surfaces agree on the today-vs-yesterday
// callout (parity gap flagged by Agent E in v1.18.1). The dashboard module is
// pure - importing it does not trigger any side effects on the MCP server path.
import { BANNER_GRADIENT, bold, renderTodayVsYesterday, tc, TRUECOLOR } from "../scripts/savings-dashboard";
import { costFor, pricingModel, PRICING_TABLE } from "./_pricing";

// Re-export under the prior public name for any downstream importers. Shape
// intentionally matches the old `{ input, output }` record so generate-badge
// and the test assertion in generate-badge.test.ts keep working.
export const PRICING: Record<string, { input: number; output: number }> = Object.fromEntries(
  Object.entries(PRICING_TABLE).map(([k, v]) => [k, { input: v.inUsd, output: v.outUsd }]),
);

// ---------------------------------------------------------------------------
// Savings report rendering
// ---------------------------------------------------------------------------

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || !Number.isFinite(ms)) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

function fmtCost(tokens: number): string {
  const c = costFor(tokens);
  if (c < 0.01) return `≈ $${c.toFixed(4)}`;
  return `≈ $${c.toFixed(2)}`;
}

function bar(value: number, max: number, width = 12): string {
  if (max <= 0 || value <= 0) return "";
  const n = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(n);
}

function pct(value: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Banner displayed at the top of every /ashlr-savings report.
// Each line stays under 80 visible chars (test enforces).
//
// 5-row block-letter "ashlr" hero with a tagline below. Letterforms are
// hand-drawn for readability of LOWERCASE shapes - the previous attempts
// (block-letter or bracket-frame) either rendered as garbled glyphs or felt
// too small. This version uses variable letter widths (a/s/h/r = 4 cols,
// l = 1 col) like real type, and density blocks (\u2593\u2592\u2591) for shading.
//
// `r` is intentionally an OPEN HOOK - vertical stem on the left, small
// terminal on the right, no closing bar. The closing bar in the previous
// design (\u2584\u2584\u2584\u2584 / \u2588\u2591\u2591\u2591\u2588) read as `P`, not `r`.
//
// renderColoredBanner() applies a top-to-bottom row gradient when truecolor
// is supported (#7cffd6 \u2192 #00d09c \u2192 #008c64); plain text fallback for
// NO_COLOR / non-TTY / piped output.
export const SAVINGS_BANNER = [
  "  \u2584\u2593\u2593\u2584    \u2584\u2593\u2593\u2584    \u2588       \u2588    \u2584\u2593\u2593\u2592",
  "  \u2593\u2591\u2591\u2593    \u2593\u2591\u2591\u2591    \u2588       \u2588    \u2588\u2591\u2591\u2592",
  "  \u2593\u2593\u2593\u2593    \u2591\u2593\u2593\u2592    \u2588\u2593\u2593\u2592    \u2588    \u2588",
  "  \u2593\u2591\u2591\u2593    \u2591\u2591\u2591\u2593    \u2588\u2591\u2591\u2593    \u2588    \u2588",
  "  \u2580\u2591\u2591\u2580    \u2580\u2593\u2593\u2580    \u2580\u2591\u2591\u2580    \u2580    \u2580",
  "",
  "  \u2593\u2591 token-efficient file tools \u2591\u2593",
].join("\n");

const SLATE_DIM: readonly [number, number, number] = [120, 130, 145];

/** Render SAVINGS_BANNER with a per-row vertical color gradient. Falls back
 * to the plain banner when truecolor is unavailable. Reuses the shared
 * gradient stops + ANSI helpers from scripts/savings-dashboard.ts so the
 * savings hero can never visually drift from the dashboard hero. */
export function renderColoredBanner(): string {
  if (!TRUECOLOR) return SAVINGS_BANNER;
  return SAVINGS_BANNER.split("\n")
    .map((line, i) => {
      if (i < BANNER_GRADIENT.length) return bold(tc(BANNER_GRADIENT[i]!, line));
      if (line.includes("token-efficient")) return tc(SLATE_DIM, line);
      return line;
    })
    .join("\n");
}

export function renderSavings(session: SessionBucket, lifetime: LifetimeBucket, extra?: ExtraContext): string {
  const model = pricingModel();
  const lines: string[] = [];
  lines.push(renderColoredBanner());
  lines.push("");
  lines.push(`ashlr savings · session started ${formatAge(session.startedAt)} · model ${model}`);
  lines.push("");
  // Summary columns
  const sLabel = `  calls    ${session.calls}`;
  const lLabel = `calls    ${lifetime.calls}`;
  const sSaved = `  saved    ${session.tokensSaved.toLocaleString()} tok`;
  const lSaved = `saved    ${lifetime.tokensSaved.toLocaleString()} tok`;
  const sCost  = `  cost     ${fmtCost(session.tokensSaved)}`;
  const lCost  = `cost     ${fmtCost(lifetime.tokensSaved)}`;
  lines.push(`this session           all-time`);
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(1, w - s.length));
  lines.push(pad(sLabel, 25) + lLabel);
  lines.push(pad(sSaved, 25) + lSaved);
  lines.push(pad(sCost, 25)  + lCost);
  lines.push("");

  // Today-vs-yesterday one-liner - shared with /ashlr-dashboard so the two
  // surfaces agree on when to celebrate a pace bump (or flag a slower day).
  // Returns "" (and is then skipped with no trailing blank) when quiet.
  const tvy = renderTodayVsYesterday(lifetime.byDay ?? {});
  if (tvy) {
    lines.push(tvy);
    lines.push("");
  }

  // By tool (session) - iterate whatever tools actually fired this session.
  lines.push("by tool (session):");
  const entries = Object.entries(session.byTool)
    .map(([name, pt]) => ({ name, calls: pt.calls, tokensSaved: pt.tokensSaved }))
    .filter((e) => e.calls > 0 || e.tokensSaved > 0)
    .sort((a, b) => b.tokensSaved - a.tokensSaved);
  if (entries.length === 0) {
    lines.push("  (no calls yet this session)");
  } else {
    const maxTok = Math.max(...entries.map((e) => e.tokensSaved), 1);
    const totalTok = entries.reduce((s, e) => s + e.tokensSaved, 0);
    for (const e of entries) {
      const name = e.name.padEnd(14);
      const calls = `${e.calls} call${e.calls === 1 ? " " : "s"}`.padEnd(10);
      const tok = `${e.tokensSaved.toLocaleString()} tok`.padEnd(13);
      lines.push(`  ${name}${calls}${tok}${bar(e.tokensSaved, maxTok).padEnd(13)}${pct(e.tokensSaved, totalTok)}`);
    }
  }
  lines.push("");

  // Last 7 days
  lines.push("last 7 days:");
  const days = lastNDays(7);
  const dayVals = days.map((d) => ({ d, v: lifetime.byDay[d]?.tokensSaved ?? 0 }));
  const maxDay = Math.max(...dayVals.map((x) => x.v), 1);
  for (const { d, v } of dayVals) {
    const label = d.slice(5); // MM-DD
    const b = v === 0 ? "(quiet)     " : bar(v, maxDay, 20).padEnd(20);
    const val = v === 0 ? "       0" : v.toLocaleString();
    lines.push(`  ${label}  ${b}  ${val}`);
  }
  lines.push("");

  // Last 30 days rollup. The 7-day view above shows *shape*; this block shows
  // the *totals* - calls, tokens, dollars - plus the single best day. They're
  // complementary: sparkline answers "when did I work?", rollup answers "how
  // much did I save?".
  lines.push("last 30 days:");
  const monthDays = lastNDays(30);
  const activeEntries = monthDays
    .map((d) => ({ d, entry: lifetime.byDay[d] }))
    .filter((x) => x.entry && (x.entry.calls > 0 || x.entry.tokensSaved > 0)) as Array<{
      d: string;
      entry: { calls: number; tokensSaved: number };
    }>;

  // Require at least 2 distinct active days before claiming a "monthly" rollup;
  // otherwise the number is just "today" dressed up as a month and misleading.
  if (activeEntries.length < 2) {
    lines.push("  (not enough history yet \u2014 come back in a few weeks)");
  } else {
    const totalCalls = activeEntries.reduce((s, x) => s + x.entry.calls, 0);
    const totalTok = activeEntries.reduce((s, x) => s + x.entry.tokensSaved, 0);
    const best = activeEntries.reduce((a, b) => (b.entry.tokensSaved > a.entry.tokensSaved ? b : a), activeEntries[0]!);
    lines.push(`  calls     ${totalCalls.toLocaleString()}`);
    lines.push(`  saved     ${totalTok.toLocaleString()} tok   ${fmtCost(totalTok)}`);
    lines.push(
      `  best day  ${best.d}    ·  ${best.entry.tokensSaved.toLocaleString()} tok   ·  ${best.entry.calls} call${best.entry.calls === 1 ? "" : "s"}`,
    );
  }

  // Extra sections (appended; never remove existing ones)
  if (extra?.topProjects && extra.topProjects.length > 0) {
    lines.push("");
    lines.push(renderPerProjectSection(extra.topProjects));
  }

  const bestDay = renderBestDaySection(lifetime);
  if (bestDay) {
    lines.push("");
    lines.push(bestDay);
  }

  const nudgeSection = renderNudgeSection(extra?.nudgeSummary, extra?.proUser ?? false);
  if (nudgeSection) {
    lines.push("");
    lines.push(nudgeSection);
  }

  // Pro upsell hint - shown when lifetime savings >= $20 and user is on Free.
  // Sits below nudge telemetry so it appears at the natural "what's next?" spot.
  const proUpsell = renderProUpsellHint(
    extra?.lifetimeDollarsSaved ?? 0,
    extra?.proUser ?? false,
  );
  if (proUpsell) {
    lines.push("");
    lines.push(proUpsell);
  }

  lines.push("");
  const calibLine = renderCalibrationLine(
    extra?.calibrationRatio ?? 4,
    extra?.calibrationPresent ?? false,
  );
  lines.push(calibLine);

  return lines.join("\n");
}

