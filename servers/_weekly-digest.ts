/**
 * _weekly-digest.ts — Once-per-week Monday banner with relatable comparisons.
 *
 * Fires on the first Monday session of the week. Tracks in:
 *   ~/.ashlr/weekly-digest.json: { lastShownWeek: "YYYY-WW" }
 *
 * Opt-out via:
 *   ASHLR_DISABLE_DIGEST=1  (env var)
 *   ~/.ashlr/config.json :: { "digest": "off" }
 *
 * Banner format (plain/no-color):
 *   Last week: 12.4M tokens saved · ~$37.20
 *   That's like 9 cups of coffee, or 2 Spotify months.
 *   Streak: 5d · top tool: ashlr__grep (43% of savings)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DigestState {
  lastShownWeek: string; // "YYYY-WW" — ISO week key
}

// ---------------------------------------------------------------------------
// Comparison bank
// ---------------------------------------------------------------------------

interface Comparison {
  /** Minimum dollar value this item represents. */
  minDollars: number;
  /** Display label when quantity > 1 (e.g. "cups of coffee"). */
  plural: string;
  /** Display label when quantity === 1 (e.g. "cup of coffee"). */
  singular: string;
  /** Dollar value of one unit. */
  unitCost: number;
}

// Ordered ascending by unitCost. The selector picks the largest item that
// yields quantity >= 1 and rounds cleanly, then multiplies.
export const COMPARISONS: readonly Comparison[] = [
  { minDollars: 0,   plural: "pencils",                    singular: "pencil",                    unitCost: 1    },
  { minDollars: 0,   plural: "song downloads",             singular: "song download",              unitCost: 1.29 },
  { minDollars: 0,   plural: "minutes of GitHub Actions",  singular: "minute of GitHub Actions",  unitCost: 0.008 },
  { minDollars: 3,   plural: "cups of coffee",             singular: "cup of coffee",              unitCost: 4    },
  { minDollars: 3,   plural: "sandwiches",                 singular: "sandwich",                   unitCost: 5    },
  { minDollars: 8,   plural: "Spotify months",             singular: "Spotify month",              unitCost: 10   },
  { minDollars: 8,   plural: "paperbacks",                 singular: "paperback",                  unitCost: 12   },
  { minDollars: 40,  plural: "dinners out",                singular: "dinner out",                 unitCost: 50   },
  { minDollars: 80,  plural: "moderate side-gig hours",   singular: "moderate side-gig hour",    unitCost: 100  },
];

/**
 * Build a relatable comparison string for the given dollar amount.
 *
 * Algorithm:
 *   1. Filter items whose minDollars <= dollars and unitCost <= dollars.
 *   2. Among those, prefer items where qty = floor(dollars/unitCost) is in
 *      the "sweet spot" range [2, 15] — these make the most relatable strings
 *      ("9 cups of coffee" beats "3 paperbacks" or "0.5 dinners").
 *   3. Within the sweet-spot candidates, pick the one with the highest unit
 *      cost (largest denomination that still gives a readable count).
 *   4. Fall back to the largest qualifying item when no sweet-spot candidate
 *      exists (e.g. very large dollar amounts).
 *
 * Returns "" when dollars < 0.01 (nothing to compare).
 */
export function buildComparison(dollars: number): string {
  if (!Number.isFinite(dollars) || dollars < 0.01) return "";

  // Collect all eligible items (minDollars <= dollars, unitCost <= dollars).
  const eligible = COMPARISONS.filter(
    (item) => dollars >= item.minDollars && dollars >= item.unitCost,
  );

  if (eligible.length === 0) {
    // Degenerate: use smallest item regardless.
    const item = COMPARISONS[0]!;
    const qty = Math.floor(dollars / item.unitCost);
    if (qty <= 0) return "";
    return `${qty} ${qty === 1 ? item.singular : item.plural}`;
  }

  // Target quantity: the "ideal" count that makes a comparison feel vivid.
  // Quantities near 5-10 are most relatable ("9 cups of coffee" > "3 paperbacks").
  // Algorithm: among eligible items, score each by how close its quantity is to
  // TARGET_QTY (lower distance = better). Break ties by higher unitCost so we
  // prefer recognizable real-world items over cheap ones.
  const TARGET_QTY = 8;

  // Compute qty for each eligible item.
  const withQty = eligible.map((item) => ({
    item,
    qty: Math.floor(dollars / item.unitCost),
  })).filter(({ qty }) => qty >= 1); // at least 1

  let best: Comparison;
  if (withQty.length === 0) {
    best = eligible[0]!;
  } else {
    best = withQty.reduce((a, b) => {
      const distA = Math.abs(a.qty - TARGET_QTY);
      const distB = Math.abs(b.qty - TARGET_QTY);
      if (distA !== distB) return distA < distB ? a : b;
      // Tie-break: higher unit cost wins (more recognizable denomination).
      return b.item.unitCost > a.item.unitCost ? b : a;
    }).item;
  }

  const qty = Math.floor(dollars / best.unitCost);
  if (qty <= 0) return "";
  const label = qty === 1 ? best.singular : best.plural;
  return `${qty} ${label}`;
}

// ---------------------------------------------------------------------------
// ISO week helper
// ---------------------------------------------------------------------------

/**
 * Returns "YYYY-WW" for the ISO week containing `date`.
 * Week 1 = the week containing the first Thursday of the year.
 */
export function isoWeekKey(date: Date = new Date()): string {
  // Copy and move to Thursday of the same week to determine the year.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Day of week: 0=Sun, 1=Mon … 6=Sat. ISO: Mon=1..Sun=7.
  const dow = d.getUTCDay() || 7; // convert Sun(0) → 7
  d.setUTCDate(d.getUTCDate() + 4 - dow); // move to Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNum).padStart(2, "0")}`;
}

/**
 * Returns the ISO week key for the week prior to `date`.
 */
export function priorWeekKey(date: Date = new Date()): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - 7);
  return isoWeekKey(d);
}

/**
 * Returns the YYYY-MM-DD keys for the 7 days of the ISO week identified by
 * `weekKey` (Mon..Sun).
 */
export function weekDayKeys(weekKey: string): string[] {
  const [yearStr, weekStr] = weekKey.split("-");
  const year = parseInt(yearStr!, 10);
  const week = parseInt(weekStr!, 10);
  // Jan 4 is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow4 = jan4.getUTCDay() || 7;
  // Monday of week 1:
  const monday1 = new Date(jan4);
  monday1.setUTCDate(monday1.getUTCDate() - (dow4 - 1));
  // Monday of our target week:
  const targetMonday = new Date(monday1);
  targetMonday.setUTCDate(targetMonday.getUTCDate() + (week - 1) * 7);
  const keys: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(targetMonday);
    d.setUTCDate(d.getUTCDate() + i);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function digestStatePath(home: string = homedir()): string {
  return join(home, ".ashlr", "weekly-digest.json");
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

export function readDigestState(home: string = homedir()): DigestState {
  try {
    const p = digestStatePath(home);
    if (!existsSync(p)) return { lastShownWeek: "" };
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<DigestState>;
    return {
      lastShownWeek: typeof raw.lastShownWeek === "string" ? raw.lastShownWeek : "",
    };
  } catch {
    return { lastShownWeek: "" };
  }
}

export function writeDigestState(data: DigestState, home: string = homedir()): void {
  try {
    mkdirSync(join(home, ".ashlr"), { recursive: true });
    writeFileSync(digestStatePath(home), JSON.stringify(data, null, 2));
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Opt-out helpers
// ---------------------------------------------------------------------------

export function isDigestDisabled(home: string = homedir()): boolean {
  // Env var opt-out.
  if (process.env.ASHLR_DISABLE_DIGEST === "1") return true;
  // Config file opt-out.
  try {
    const cfgPath = join(home, ".ashlr", "config.json");
    if (!existsSync(cfgPath)) return false;
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
    return raw.digest === "off";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stats types (minimal — we only need byDay + byTool)
// ---------------------------------------------------------------------------

export interface DigestStats {
  lifetime?: {
    byDay?: Record<string, { tokensSaved?: number; calls?: number }>;
    byTool?: Record<string, { tokensSaved?: number; calls?: number }>;
  };
}

// ---------------------------------------------------------------------------
// Banner building
// ---------------------------------------------------------------------------

export interface DigestBannerOpts {
  home?: string;
  now?: Date;
  stats?: DigestStats;
  /** Dollars saved (injected by caller; computed from costFor). */
  dollarsSaved?: number;
  /** Current streak length (from _streaks.ts). */
  currentStreak?: number;
  /**
   * Test hook: when true, marks the digest as shown in state but skips the
   * actual write so tests stay isolated.
   */
  suppressStateWrite?: boolean;
}

export interface DigestBannerResult {
  /** The rendered banner text, or null if the digest should not fire. */
  banner: string | null;
  /** Whether this is the first time we're showing this week's digest. */
  fired: boolean;
}

export interface DigestBannerContent {
  tokens: number;
  dollars: number;
  comparisonA: string;
  comparisonB: string;
  currentStreak: number;
  topTool: string;
  topToolPct: number;
}

/**
 * Build the banner content fields without any IO side-effects.
 * Pure function — used by tests and by buildDigestBanner.
 */
export function computeBannerContent(
  opts: Required<Pick<DigestBannerOpts, "now" | "stats" | "dollarsSaved" | "currentStreak">>,
): DigestBannerContent {
  const { now, stats, dollarsSaved, currentStreak } = opts;
  const prior = priorWeekKey(now);
  const dayKeys = weekDayKeys(prior);
  const byDay = stats.lifetime?.byDay ?? {};
  const tokens = dayKeys.reduce((sum, k) => sum + (byDay[k]?.tokensSaved ?? 0), 0);
  const dollars = dollarsSaved ?? 0;

  // Two independent comparisons for variety.
  const compA = buildComparison(dollars);
  // For the second comparison pick the next-size-up item if possible.
  let compB = "";
  const aIdx = COMPARISONS.findIndex((c) => compA.includes(c.plural) || compA.includes(c.singular));
  if (aIdx > 0) {
    const alt = COMPARISONS[aIdx - 1];
    if (alt && dollars >= alt.unitCost) {
      const qty = Math.floor(dollars / alt.unitCost);
      compB = qty > 0 ? `${qty} ${qty === 1 ? alt.singular : alt.plural}` : "";
    }
  }

  // Top tool by tokens saved last week.
  const byTool = stats.lifetime?.byTool ?? {};
  let topTool = "";
  let topTok = 0;
  for (const [name, t] of Object.entries(byTool)) {
    const tok = t?.tokensSaved ?? 0;
    if (tok > topTok) { topTok = tok; topTool = name; }
  }
  const topToolPct = tokens > 0 && topTok > 0 ? Math.round((topTok / tokens) * 100) : 0;

  return { tokens, dollars, comparisonA: compA, comparisonB: compB, currentStreak, topTool, topToolPct };
}

/**
 * Render the digest banner as a plain-text string (no ANSI — the session-greet
 * layer will apply its own color if appropriate).
 */
export function renderDigestBanner(content: DigestBannerContent): string {
  const { tokens, dollars, comparisonA, comparisonB, currentStreak, topTool, topToolPct } = content;

  function fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(1) + "K";
    return (n / 1_000_000).toFixed(1) + "M";
  }

  const dollarStr = dollars < 0.01 ? "~$0.00" : dollars < 100
    ? `~$${dollars.toFixed(2)}`
    : `~$${Math.round(dollars)}`;

  const lines: string[] = [];
  lines.push(`Last week: ${fmtTokens(tokens)} tokens saved · ${dollarStr}`);

  const comparisons: string[] = [];
  if (comparisonA) comparisons.push(comparisonA);
  if (comparisonB && comparisonB !== comparisonA) comparisons.push(comparisonB);
  if (comparisons.length > 0) {
    lines.push(`That's like ${comparisons.join(", or ")}.`);
  }

  const meta: string[] = [];
  if (currentStreak >= 3) meta.push(`${currentStreak}d streak`);
  if (topTool && topToolPct > 0) meta.push(`top tool: ${topTool} (${topToolPct}% of savings)`);
  if (meta.length > 0) {
    lines.push(meta.join(" · "));
  }

  return lines.join("\n");
}

/**
 * Main entry point: check if a weekly digest should fire, build + return the
 * banner text, and mark the week as shown.
 *
 * Returns null when:
 *   - digest is disabled (env/config opt-out)
 *   - already shown this week
 *   - total tokens == 0 (nothing happened last week)
 */
export function buildDigestBanner(opts: DigestBannerOpts = {}): DigestBannerResult {
  const home = opts.home ?? homedir();
  const now = opts.now ?? new Date();

  if (isDigestDisabled(home)) return { banner: null, fired: false };

  const thisWeek = isoWeekKey(now);
  const state = readDigestState(home);
  if (state.lastShownWeek === thisWeek) return { banner: null, fired: false };

  const stats = opts.stats ?? ({} as DigestStats);
  const dollars = opts.dollarsSaved ?? 0;

  const content = computeBannerContent({
    now,
    stats,
    dollarsSaved: dollars,
    currentStreak: opts.currentStreak ?? 0,
  });

  // Suppress empty banners.
  if (content.tokens <= 0) return { banner: null, fired: false };

  const banner = renderDigestBanner(content);

  // Mark as shown.
  if (!opts.suppressStateWrite) {
    writeDigestState({ lastShownWeek: thisWeek }, home);
  }

  return { banner, fired: true };
}
