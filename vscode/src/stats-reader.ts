import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { StatsFile, AggregatedSession, ByTool } from "./types";

/**
 * Resolve the path to stats.json, honouring the ashlr.statsPath setting.
 */
export function resolveStatsPath(): string {
  const cfg = vscode.workspace.getConfiguration("ashlr");
  const custom: string = cfg.get("statsPath") ?? "";
  if (custom.trim()) {
    return custom.replace(/^~/, os.homedir());
  }
  return path.join(os.homedir(), ".ashlr", "stats.json");
}

/**
 * Read and parse stats.json. Returns null when the file is absent or unparseable.
 * Silently tolerates missing file (ashlr not yet run).
 */
export function readStats(): StatsFile | null {
  const p = resolveStatsPath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as StatsFile;
    // Tolerate both v1 and v2 shapes
    if (!parsed.lifetime) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Aggregate all session buckets into a single totals object.
 * The v2 schema stores one bucket per CLAUDE_SESSION_ID.
 */
export function aggregateSessions(stats: StatsFile): AggregatedSession {
  let calls = 0;
  let tokensSaved = 0;
  const byTool: ByTool = {};

  for (const bucket of Object.values(stats.sessions ?? {})) {
    calls += bucket.calls ?? 0;
    tokensSaved += bucket.tokensSaved ?? 0;
    for (const [tool, tv] of Object.entries(bucket.byTool ?? {})) {
      if (!byTool[tool]) byTool[tool] = { calls: 0, tokensSaved: 0 };
      byTool[tool].calls += tv.calls ?? 0;
      byTool[tool].tokensSaved += tv.tokensSaved ?? 0;
    }
  }

  return { calls, tokensSaved, byTool };
}

/**
 * Format a token count for display (e.g. 12400 -> "12.4k").
 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Format a dollar cost estimate. Assumes $3/1M tokens (Claude Sonnet mid).
 */
export function fmtCost(tokens: number): string {
  const dollars = (tokens / 1_000_000) * 3;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  return `$${(dollars * 100).toFixed(1)}¢`.replace("$", "");
}

/**
 * Best single day by tokens saved, from lifetime.byDay.
 */
export function bestDay(stats: StatsFile): { date: string; tokensSaved: number } | null {
  const byDay = stats.lifetime?.byDay ?? {};
  let best: { date: string; tokensSaved: number } | null = null;
  for (const [date, v] of Object.entries(byDay)) {
    if (!best || (v.tokensSaved ?? 0) > best.tokensSaved) {
      best = { date, tokensSaved: v.tokensSaved ?? 0 };
    }
  }
  return best;
}

/**
 * Last N days of token savings as an array ordered oldest-first.
 */
export function lastNDays(stats: StatsFile, n: number): number[] {
  const byDay = stats.lifetime?.byDay ?? {};
  const dates = Object.keys(byDay).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const slice = dates.slice(-n);
  const result: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = slice[i];
    result.push(d ? (byDay[d]?.tokensSaved ?? 0) : 0);
  }
  return result;
}

/**
 * Projected annual token savings based on last 30 days.
 */
export function projectedAnnual(stats: StatsFile): number {
  const days = lastNDays(stats, 30);
  const total = days.reduce((a, b) => a + b, 0);
  const activeDays = days.filter((x) => x > 0).length;
  if (activeDays === 0) return 0;
  const dailyAvg = total / activeDays;
  return Math.round(dailyAvg * 365);
}
