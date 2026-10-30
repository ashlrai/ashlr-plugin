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
import { fmtCost, formatAge, renderToolAndDaySections } from "./_efficiency-shared";
import { pricingModel as _pricingModel } from "./_pricing";
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
import { renderTuningSection } from "./_tuning-render";

// ASCII banner displayed at the top of every /ashlr-savings report.
// Must stay under 60 visible chars wide (tests assert <= 80).
export const SAVINGS_BANNER = [
  "  ▄▀█ █▀█ █ █ █   █▀█",
  "  █▀█ ▄█ █▀█ █▄█   █▀▀    token-efficient file tools",
].join("\n");

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
  // v1.34: when >= 10 measured calls exist, show API-measured figure; else estimate.
  const measuredCalls = lifetime.measuredCalls ?? 0;
  const showMeasured = measuredCalls >= 10;
  const sessionTokDisplay = showMeasured ? (session.tokensSavedMeasured ?? 0) : session.tokensSaved;
  const lifetimeTokDisplay = showMeasured ? (lifetime.tokensSavedMeasured ?? 0) : lifetime.tokensSaved;
  const methodLabel = showMeasured ? '(API-measured)' : '(est.)';
  const sSaved = `  saved    ${sessionTokDisplay.toLocaleString()} tok ${methodLabel}`;
  const lSaved = `saved    ${lifetimeTokDisplay.toLocaleString()} tok ${methodLabel}`;
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

  lines.push(...renderToolAndDaySections(session, lifetime));

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

  // Self-tuning: net savings and miss rate by week (this repo).
  try {
    const home = process.env.ASHLR_HOME_OVERRIDE?.trim() || process.env.HOME || process.env.USERPROFILE || "";
    const tuning = home ? renderTuningSection(home) : null;
    if (tuning) {
      lines.push("");
      lines.push(tuning);
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
