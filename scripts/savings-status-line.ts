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
  lifetime?: { calls?: number; tokensSaved?: number };
}

interface AshlrSettings {
  statusLine?: boolean;
  statusLineSession?: boolean;
  statusLineLifetime?: boolean;
  statusLineTips?: boolean;
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
  "lifetime savings persist in ~/.ashlr/stats.json",
];

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
}

export function buildStatusLine(opts: BuildOptions = {}): string {
  try {
    const home = opts.home ?? homedir();
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

    const stats = readJson<Stats>(join(home, ".ashlr", "stats.json"));
    const session = stats?.session?.tokensSaved ?? 0;
    const lifetime = stats?.lifetime?.tokensSaved ?? 0;

    const parts: string[] = ["ashlr"];
    if (showSession) parts.push(`session +${formatTokens(session)}`);
    if (showLifetime) parts.push(`lifetime +${formatTokens(lifetime)}`);

    let line = parts.join(" · ");

    if (showTips) {
      const tip = pickTip(TIPS, opts.tipSeed);
      const candidate = `${line} · tip: ${tip}`;
      if (candidate.length <= MAX_LEN) line = candidate;
    }

    if (line.length > MAX_LEN) line = line.slice(0, MAX_LEN - 1) + "…";
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
