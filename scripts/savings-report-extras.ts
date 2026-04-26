/**
 * savings-report-extras.ts
 *
 * Three additional sections for the ashlr__savings renderer.
 * Called from renderSavings() in servers/efficiency-server.ts.
 * All functions are tolerant of missing files/data and never throw.
 *
 * Sections:
 *   1. renderPerProjectSection  — top-5 projects by call count (from session-log)
 *   2. renderBestDaySection     — single best day overall + its relative position
 *   3. renderCalibrationLine    — one-line calibration confidence note
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import type { LifetimeBucket } from "../servers/_stats.ts";
import {
  CALIBRATION_PATH,
  DEFAULT_MULTIPLIER,
  getCalibrationMultiplier,
  type CalibrationFile,
} from "./read-calibration.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  name: string;
  calls: number;
  toolVariety: number;
}

export interface ExtraContext {
  /** Top 5 projects from session-log, pre-computed. */
  topProjects?: ProjectInfo[];
  /** Mean ratio from calibration — undefined means file is absent. */
  calibrationRatio?: number;
  /** True when calibration.json actually exists on disk. */
  calibrationPresent?: boolean;
  /** Pre-computed nudge telemetry summary (shown / clicked / dismissed). */
  nudgeSummary?: NudgeSummary;
  /** True when a local pro-token is present — suppresses the "try Pro" nudge stats
   *  in contexts where showing the nudge no longer applies. */
  proUser?: boolean;
  /** Lifetime dollar cost saved (pre-computed). Used for Pro upsell threshold. */
  lifetimeDollarsSaved?: number;
}

// ---------------------------------------------------------------------------
// Pro upsell hint
// Threshold: $20 lifetime saved. At sonnet-4.6 pricing ($2.50/MTok input)
// that is 8 million tokens — a legitimate signal of regular engagement.
// Pro at $12/mo is a clear value proposition once someone is saving this much.
// ---------------------------------------------------------------------------

/** Threshold at which the Pro upsell hint is shown (lifetime dollars saved). */
export const PRO_UPSELL_THRESHOLD_DOLLARS = 20;

/**
 * Returns a one-line Pro upsell hint when:
 *   - lifetime cost saved >= PRO_UPSELL_THRESHOLD_DOLLARS, AND
 *   - the user is NOT already on Pro/Team (proUser=false).
 *
 * Returns empty string otherwise (caller must check before appending).
 */
export function renderProUpsellHint(
  lifetimeDollarsSaved: number,
  proUser: boolean,
  lifetimeDollarsFmt?: string,
): string {
  if (proUser) return "";
  if (lifetimeDollarsSaved < PRO_UPSELL_THRESHOLD_DOLLARS) return "";
  const dollarStr = lifetimeDollarsFmt ?? `$${lifetimeDollarsSaved.toFixed(0)}`;
  return (
    `You've saved ${dollarStr} lifetime on Free. Pro adds cross-machine sync + cloud genome. ` +
    `Try /ashlr-upgrade.`
  );
}

export interface NudgeSummary {
  shown: number;
  clicked: number;
  dismissed: number;
  conversionPct: number;
}

// ---------------------------------------------------------------------------
// Session-log reader
// Reuses parse logic aligned with session-log-report.ts; kept local to avoid
// circular imports (session-log-report imports savings-status-line).
// ---------------------------------------------------------------------------

interface LogRecord {
  ts: string;
  event: string;
  tool: string;
  cwd: string;
}

function readLogLines(home: string): string[] {
  const lines: string[] = [];
  for (const fname of ["session-log.jsonl.1", "session-log.jsonl"]) {
    const p = join(home, ".ashlr", fname);
    if (!existsSync(p)) continue;
    try {
      lines.push(
        ...readFileSync(p, "utf-8")
          .split("\n")
          .filter((l) => l.trim().length > 0),
      );
    } catch {
      // tolerate read errors
    }
  }
  return lines;
}

function parseLogRecords(lines: string[]): LogRecord[] {
  const out: LogRecord[] = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as Partial<LogRecord>;
      if (typeof r.ts !== "string" || typeof r.event !== "string") continue;
      if (r.event === "session_end") continue;
      out.push({
        ts: r.ts,
        event: r.event,
        tool: r.tool ?? "unknown",
        cwd: r.cwd ?? "",
      });
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/**
 * Build top-5 project list from session-log.
 * Exported so tests can call directly.
 */
export function buildTopProjects(home?: string): ProjectInfo[] {
  const h = home ?? homedir();
  const lines = readLogLines(h);
  if (lines.length === 0) return [];

  const records = parseLogRecords(lines);
  const projectMap = new Map<string, { calls: number; tools: Set<string> }>();

  for (const r of records) {
    if (!r.cwd) continue;
    let ps = projectMap.get(r.cwd);
    if (!ps) {
      ps = { calls: 0, tools: new Set() };
      projectMap.set(r.cwd, ps);
    }
    ps.calls++;
    ps.tools.add(r.tool);
  }

  return [...projectMap.entries()]
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 5)
    .map(([path, stat]) => ({
      name: basename(path) || path,
      calls: stat.calls,
      toolVariety: stat.tools.size,
    }));
}

/**
 * Gather calibration state: returns ratio (actual or default) + presence flag.
 * Uses getCalibrationMultiplier from read-calibration.ts (reuse, don't dupe).
 */
export function readCalibrationState(calibPath?: string): {
  ratio: number;
  present: boolean;
} {
  const p = calibPath ?? CALIBRATION_PATH;
  const present = existsSync(p);
  const ratio = getCalibrationMultiplier(p);
  return { ratio, present };
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

/**
 * Section 1: per-project breakdown — top 5 by call count.
 * Returns empty string when no data.
 */
export function renderPerProjectSection(projects: ProjectInfo[]): string {
  if (projects.length === 0) return "";
  const lines: string[] = [];
  lines.push("top projects (by call count):");
  for (const p of projects) {
    const name = p.name.length > 32 ? "..." + p.name.slice(-29) : p.name;
    const namePad = name.padEnd(35);
    const callStr = `${p.calls} call${p.calls === 1 ? " " : "s"}`.padEnd(12);
    const toolStr = `${p.toolVariety} tool${p.toolVariety === 1 ? "" : "s"}`;
    lines.push(`  ${namePad}${callStr}${toolStr}`);
  }
  return lines.join("\n");
}

/**
 * Section 2: best day overall + its relative position.
 * Scans lifetime.byDay for the single best day.
 * Returns empty string when no data.
 */
export function renderBestDaySection(lifetime: LifetimeBucket): string {
  const entries = Object.entries(lifetime.byDay).filter(
    ([, v]) => v.tokensSaved > 0,
  );
  if (entries.length === 0) return "";

  entries.sort((a, b) => b[1].tokensSaved - a[1].tokensSaved);
  const [bestDate, bestVal] = entries[0]!;

  // Compute average from up to 6 other recent days for context.
  const recentOthers = entries.slice(1, 7);
  const avgTok =
    recentOthers.length > 0
      ? Math.round(
          recentOthers.reduce((s, [, v]) => s + v.tokensSaved, 0) /
            recentOthers.length,
        )
      : 0;

  const lines: string[] = [];
  lines.push("best day:");
  lines.push(
    `  ${bestDate}    ${bestVal.tokensSaved.toLocaleString()} tok saved` +
      `   ${bestVal.calls} call${bestVal.calls === 1 ? "" : "s"}`,
  );
  if (avgTok > 0) {
    const mult = (bestVal.tokensSaved / avgTok).toFixed(1);
    lines.push(
      `  (${mult}x your recent avg of ${avgTok.toLocaleString()} tok/day)`,
    );
  }
  return lines.join("\n");
}

/**
 * Section 3: calibration confidence — one line.
 * present=true  → empirical measurement exists
 * present=false → only the default 4x estimate
 */
export function renderCalibrationLine(ratio: number, present: boolean): string {
  if (present) {
    return `calibration: grep baseline is empirical (mean ratio ${ratio.toFixed(1)}x)`;
  }
  return `calibration: grep baseline is estimated (${DEFAULT_MULTIPLIER}x -- run calibrate-grep.ts)`;
}

/**
 * Section 4: nudge telemetry — "Shown X times, clicked Y (Z%)".
 *
 * Returns empty string when no events have been recorded. When the user is
 * on Pro/Team we still print historical stats for curiosity — we just
 * relabel the header so it reads as past-tense rather than a live prompt.
 */
export function renderNudgeSection(summary: NudgeSummary | undefined, proUser: boolean): string {
  if (!summary || summary.shown === 0) return "";
  const header = proUser ? "pro upgrade (historical nudge stats):" : "pro upgrade nudge:";
  const lines: string[] = [];
  lines.push(header);
  const conv = summary.conversionPct.toFixed(1);
  lines.push(
    `  shown ${summary.shown} · clicked ${summary.clicked} · rate ${conv}%`,
  );
  if (summary.dismissed > 0) {
    lines.push(`  dismissed (session ended, no click): ${summary.dismissed}`);
  }
  return lines.join("\n");
}
