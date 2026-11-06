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
import { fmtCost, formatAge, renderToolAndDaySections } from "./_efficiency-shared";
import { pricingModel, PRICING_TABLE } from "./_pricing";

// Re-export under the prior public name for any downstream importers. Shape
// intentionally matches the old `{ input, output }` record so generate-badge
// and the test assertion in generate-badge.test.ts keep working.
export const PRICING: Record<string, { input: number; output: number }> = Object.fromEntries(
  Object.entries(PRICING_TABLE).map(([k, v]) => [k, { input: v.inUsd, output: v.outUsd }]),
);

// ---------------------------------------------------------------------------
// Savings report rendering
// ---------------------------------------------------------------------------

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

