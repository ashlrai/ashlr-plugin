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
  /** Opportunity hints context for renderTopOpportunitySection. */
  opportunity?: OpportunityContext;
}

export interface OpportunityContext {
  /** True when .ashlrcode/genome/manifest.json does NOT exist in cwd. */
  noGenome: boolean;
  /** How many grep calls occurred this week (from session-log). */
  weeklyGrepCalls: number;
  /** Active hook mode ("redirect" | "nudge" | "off"). */
  hookMode: string;
  /** Adoption funnel conversion pct (0–100). 0 when no data. */
  conversionPct: number;
  /** How many tool_fallback events recorded (snipCompact fallbacks). */
  fallbackCount: number;
  /** True when an LLM provider key is set (ANTHROPIC_API_KEY present). */
  hasLlmProvider: boolean;
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

/**
 * Section 5: top opportunity hints — surfaced when /ashlr-savings is run.
 *
 * Shows at most 2 items to avoid overwhelming the user. Priority:
 *   1. Genome missing + heavy grep → "Run /ashlr-genome-init"
 *   2. No LLM provider + many fallbacks → "Install ONNX or set ANTHROPIC_API_KEY"
 *   3. Nudge mode + low conversion → "Switch to redirect mode"
 *
 * Returns empty string when there are no actionable hints.
 */
export function renderTopOpportunitySection(ctx: OpportunityContext | undefined): string {
  if (!ctx) return "";

  const hints: string[] = [];

  // Opportunity 1: genome missing + grep-heavy
  if (ctx.noGenome && ctx.weeklyGrepCalls > 5) {
    hints.push(
      `  genome not initialised (${ctx.weeklyGrepCalls} grep calls this week). ` +
      `Run \`/ashlr-genome-init\` to enable RAG-mode grep (+20% more savings).`,
    );
  }

  // Opportunity 2: no LLM provider + many snipCompact fallbacks
  if (!ctx.hasLlmProvider && ctx.fallbackCount > 10) {
    hints.push(
      `  no LLM provider (${ctx.fallbackCount} snipCompact fallbacks). ` +
      `Run \`bun run install-onnx-model\` for offline summarization, ` +
      `or set ANTHROPIC_API_KEY for Haiku-quality summaries.`,
    );
  }

  // Opportunity 3: nudge mode + low conversion
  if (ctx.hookMode === "nudge" && ctx.conversionPct < 50) {
    hints.push(
      `  hook mode is "nudge" at ${ctx.conversionPct.toFixed(0)}% conversion. ` +
      `Set ASHLR_HOOK_MODE=redirect for automatic enforcement: ` +
      `\`bun run scripts/set-hook-mode.ts redirect\`.`,
    );
  }

  if (hints.length === 0) return "";

  const lines: string[] = [];
  lines.push("top opportunities:");
  // Cap at 2.
  for (const h of hints.slice(0, 2)) {
    lines.push(h);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Opportunity context builder — called by savings-server.ts
// ---------------------------------------------------------------------------

/**
 * Read the weekly grep call count from session-log for the past 7 days.
 * Best-effort — returns 0 on any error.
 */
export function countWeeklyGrepCalls(home?: string): number {
  const h = home ?? homedir();
  const lines = readLogLines(h);
  if (lines.length === 0) return 0;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as Partial<{ ts: string; tool: string }>;
      if (typeof r.ts !== "string") continue;
      if (new Date(r.ts).getTime() < cutoff) continue;
      if (typeof r.tool === "string" && r.tool.includes("grep")) count++;
    } catch {
      // skip
    }
  }
  return count;
}

/**
 * Count tool_fallback events in session-log (proxy for snipCompact fallbacks).
 * Best-effort — returns 0 on any error.
 */
export function countFallbackEvents(home?: string): number {
  const h = home ?? homedir();
  const lines = readLogLines(h);
  let count = 0;
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as Partial<{ event: string }>;
      if (r.event === "tool_fallback") count++;
    } catch {
      // skip
    }
  }
  return count;
}

/**
 * True when .ashlrcode/genome/manifest.json does NOT exist in cwd.
 */
export function isGenomeMissing(cwd?: string): boolean {
  try {
    const dir = cwd ?? process.cwd();
    return !existsSync(join(dir, ".ashlrcode", "genome", "manifest.json"));
  } catch {
    return true;
  }
}
