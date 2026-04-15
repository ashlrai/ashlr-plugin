#!/usr/bin/env bun
/**
 * ashlr status line script.
 *
 * Claude Code invokes this command periodically and renders the first line of
 * stdout in its status bar. We surface lifetime + session token-savings from
 * ~/.ashlr/stats.json, gated by toggles in ~/.claude/settings.json under the
 * "ashlr" key:
 *
 *   {
 *     "ashlr": {
 *       "statusLine":         true,   // master switch (default: true)
 *       "statusLineSession":  true,   // show "session +N" segment
 *       "statusLineLifetime": true,   // show "lifetime +N" segment
 *       "statusLineTips":     true    // rotate a helpful tip at the end
 *     }
 *   }
 *
 * Contract:
 *   - Always exits 0.
 *   - On any error, emits an empty line.
 *   - Output is a single line, target ≤ 80 chars (Claude Code truncates
 *     overflow rather than scrolling, so we self-trim).
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface Stats {
  session?: { calls?: number; tokensSaved?: number };
  lifetime?: {
    calls?: number;
    tokensSaved?: number;
    byDay?: Record<string, { calls?: number; tokensSaved?: number }>;
  };
}

interface AshlrSettings {
  statusLine?: boolean;
  statusLineSession?: boolean;
  statusLineLifetime?: boolean;
  statusLineTips?: boolean;
  statusLineSparkline?: boolean;
}

// 9-rung Braille ladder: empty → full. Each char represents one day's
// tokens-saved, bucketed against the busiest day in the window.
//   0% → ⠀ (U+2800, blank-but-present braille), 100% → ⣿
const SPARK_LADDER = ["\u2800", "\u2840", "\u2844", "\u2846", "\u2847", "\u28E7", "\u28F7", "\u28FF", "\u28FF"];
// Note: we use a 9-slot ladder so that ratio 0 maps to blank, anything >0 maps
// to at least the first rung (so an active-but-quiet day is still visible).

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

export function renderSparkline(
  byDay: Record<string, { tokensSaved?: number }> | undefined,
  days = 7,
): string {
  const keys = lastNDayKeys(days);
  const vals = keys.map((k) => byDay?.[k]?.tokensSaved ?? 0);
  const max = Math.max(...vals, 0);
  if (max <= 0) return SPARK_LADDER[0]!.repeat(days);
  return vals
    .map((v) => {
      if (v <= 0) return SPARK_LADDER[0]!;
      // Scale 1..max → rungs 1..8 (skip rung 0 so any activity is visible).
      const idx = Math.max(1, Math.min(8, Math.ceil((v / max) * 8)));
      return SPARK_LADDER[idx]!;
    })
    .join("");
}

const MAX_LEN = 80;

// Editable list — keep small, keep useful.
const TIPS: readonly string[] = [
  "use /ashlr-savings to see totals",
  "ashlr__read auto-snips files >2KB",
  "ashlr__edit ships diffs, not full files",
  "ashlr__grep is genome-aware in mapped repos",
  "toggle status line via /ashlr-settings",
  "run `ashlr map` to build a code genome",
  "savings persist in ~/.ashlr/stats.json",
];

/** Resolve the terminal-width budget for the status line.
 *  - Reads $COLUMNS from the environment (terminals typically set this).
 *  - Clamped to [1, 120] to avoid absurdly wide rendering.
 *  - Falls back to 80 when unset/invalid.
 */
export function resolveBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COLUMNS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 80;
  return Math.min(parsed, 120);
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "K";
  return (n / 1_000_000).toFixed(1) + "M";
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function pickTip(tips: readonly string[], seed?: number): string {
  if (tips.length === 0) return "";
  const idx = (seed ?? Math.floor(Date.now() / 86_400_000)) % tips.length;
  return tips[idx]!;
}

export interface BuildOptions {
  home?: string;
  /** Deterministic tip index, used by tests. */
  tipSeed?: number;
  /** Explicit budget override (bypasses $COLUMNS detection). */
  budget?: number;
  /** Environment to read $COLUMNS from — used by tests. */
  env?: NodeJS.ProcessEnv;
}

export function buildStatusLine(opts: BuildOptions = {}): string {
  try {
    const home = opts.home ?? homedir();
    const budget = opts.budget ?? resolveBudget(opts.env);
    const settings = readJson<{ ashlr?: AshlrSettings }>(
      join(home, ".claude", "settings.json"),
    );
    const cfg: AshlrSettings = settings?.ashlr ?? {};

    // Defaults: master on, session on, lifetime on, tips on.
    const master = cfg.statusLine ?? true;
    if (!master) return "";

    const showSession = cfg.statusLineSession ?? true;
    const showLifetime = cfg.statusLineLifetime ?? true;
    const showTips = cfg.statusLineTips ?? true;
    const showSpark = cfg.statusLineSparkline ?? true;

    const stats = readJson<Stats>(join(home, ".ashlr", "stats.json"));
    const session = stats?.session?.tokensSaved ?? 0;
    const lifetime = stats?.lifetime?.tokensSaved ?? 0;

    // Sparkline rides right after the brand, separated by a single space (not
    // a middle-dot) so it reads as a glyph on the brand rather than its own
    // column.
    const brand = showSpark ? `ashlr ${renderSparkline(stats?.lifetime?.byDay, 7)}` : "ashlr";
    const parts: string[] = [brand];
    if (showSession) parts.push(`session +${formatTokens(session)}`);
    if (showLifetime) parts.push(`lifetime +${formatTokens(lifetime)}`);

    let line = parts.join(" · ");

    if (showTips) {
      const tip = pickTip(TIPS, opts.tipSeed);
      const candidate = `${line} · tip: ${tip}`;
      if (candidate.length <= budget) {
        line = candidate;
      }
      // If the full tip doesn't fit, drop it cleanly rather than show a
      // mid-word truncation like "tip: a…". We only consider showing a
      // partial tip when the remaining room is ≥ 15 chars, which is enough
      // for a recognizable hint; otherwise we drop the tip entirely.
      else {
        const remaining = budget - line.length - " · tip: ".length;
        if (remaining >= 15 && tip.length <= remaining) {
          line = candidate; // safety net — already covered above but explicit.
        }
        // else: drop the tip entirely (no partial/truncated rendering).
      }
    }

    if (line.length > budget) line = line.slice(0, budget - 1) + "…";
    return line;
  } catch {
    return "";
  }
}

// Run as script (skip when imported by tests).
if (import.meta.main) {
  process.stdout.write(buildStatusLine() + "\n");
  process.exit(0);
}
