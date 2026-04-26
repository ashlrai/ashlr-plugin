/**
 * _savings-render — renderSavings + display helpers for ashlr__savings.
 *
 * Read-only module: no side effects, no state. Shared between savings-server
 * and any other surface (e.g. scripts/savings-dashboard.ts) that needs to
 * render the standard savings report.
 */

import {
  type LifetimeBucket,
  type SessionBucket,
} from "./_stats";
import { costFor as _costFor, pricingModel as _pricingModel } from "./_pricing";
import {
  renderPerProjectSection,
  renderBestDaySection,
  renderCalibrationLine,
  renderNudgeSection,
  renderTopOpportunitySection,
  type ExtraContext,
} from "../scripts/savings-report-extras";
import { renderTodayVsYesterday } from "../scripts/savings-dashboard";
import { readStreaks } from "./_streaks";

// ASCII banner displayed at the top of every /ashlr-savings report.
// Must stay under 60 visible chars wide (tests assert <= 80).
export const SAVINGS_BANNER = [
  "  ▄▀█ █▀█ █ █ █   █▀█",
  "  █▀█ ▄█ █▀█ █▄█   █▀▀    token-efficient file tools",
].join("\n");

function fmtCost(tokens: number): string {
  const c = _costFor(tokens);
  if (c < 0.01) return `≈ $${c.toFixed(4)}`;
  return `≈ $${c.toFixed(2)}`;
}

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

export function renderSavings(session: SessionBucket, lifetime: LifetimeBucket, extra?: ExtraContext): string {
  const model = _pricingModel();
  const lines: string[] = [];
  lines.push(SAVINGS_BANNER);
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

  // Today-vs-yesterday one-liner — shared with /ashlr-dashboard so the two
  // surfaces agree on when to celebrate a pace bump (or flag a slower day).
  // Returns "" (and is then skipped with no trailing blank) when quiet.
  const tvy = renderTodayVsYesterday(lifetime.byDay ?? {});
  if (tvy) {
    lines.push(tvy);
    lines.push("");
  }

  // By tool (session) — iterate whatever tools actually fired this session.
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

  // Last 30 days rollup
  lines.push("last 30 days:");
  const monthDays = lastNDays(30);
  const activeEntries = monthDays
    .map((d) => ({ d, entry: lifetime.byDay[d] }))
    .filter((x) => x.entry && (x.entry.calls > 0 || x.entry.tokensSaved > 0)) as Array<{
      d: string;
      entry: { calls: number; tokensSaved: number };
    }>;

  // Require at least 2 distinct active days before claiming a "monthly" rollup.
  if (activeEntries.length < 2) {
    lines.push("  (not enough history yet — come back in a few weeks)");
  } else {
    const totalCalls = activeEntries.reduce((s, x) => s + x.entry.calls, 0);
    const totalTok = activeEntries.reduce((s, x) => s + x.entry.tokensSaved, 0);
    const best = activeEntries.reduce((a, b) => (b.entry.tokensSaved > a.entry.tokensSaved ? b : a));
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

  // Track FF: streak line — show when currentStreak >= 3.
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const streakData = readStreaks(home || undefined);
    if (streakData.currentStreak >= 3) {
      lines.push("");
      lines.push(
        `streak: ${streakData.currentStreak}d active  (best: ${streakData.longestStreak}d · last active: ${streakData.lastActiveDay || "—"})`,
      );
    }
  } catch {
    /* best-effort */
  }

  // Track GG: top opportunity hint (genome init / LLM provider / hook mode).
  const opportunitySection = renderTopOpportunitySection(extra?.opportunity);
  if (opportunitySection) {
    lines.push("");
    lines.push(opportunitySection);
  }

  lines.push("");
  const calibLine = renderCalibrationLine(
    extra?.calibrationRatio ?? 4,
    extra?.calibrationPresent ?? false,
  );
  lines.push(calibLine);

  return lines.join("\n");
}
