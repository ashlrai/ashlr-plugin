#!/usr/bin/env bun
/**
 * scripts/weekly-digest.ts — Weekly digest renderer.
 *
 * Wraps servers/_weekly-digest.ts to produce a markdown report to stdout.
 *
 * Sections (Pro users):
 *   - Top 5 tools used this week (count + share %)
 *   - Genome learnings (new section count; top 3 by token impact if available)
 *   - Streak status (current streak, vs last week)
 *   - Total tokens + $ saved this week
 *
 * Free-tier users see a 3-line teaser instead of the full digest.
 *
 * Integration with /ashlr-resume: buildResumeWithDigest() prepends the
 * digest when 7+ days have elapsed since last_digest_shown_ts.
 *
 * Email delivery: deferred to v1.32. This file ships markdown-to-stdout only.
 * (Decision: ship markdown render first; email route server/src/emails/weekly-digest.tsx
 * can ride v1.32 once we verify engagement with the text version.)
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  buildDigestBanner,
  isoWeekKey,
  priorWeekKey,
  weekDayKeys,
  type DigestStats,
} from "../servers/_weekly-digest.ts";
import { readStreaks } from "../servers/_streaks.ts";
import { costFor } from "../servers/_pricing.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeeklyDigestOpts {
  /** Override home dir — used by tests. */
  home?: string;
  /** Injected now — used by tests. */
  now?: Date;
  /** Override Pro status detection — used by tests. */
  isPro?: boolean;
  /**
   * When true, the digest runs even if shown less than 7 days ago.
   * Used by force-render calls and tests.
   */
  force?: boolean;
  /**
   * When true, does not update last_digest_shown_ts in state.
   * Used by tests to stay isolated.
   */
  suppressStateWrite?: boolean;
}

export interface WeeklyDigestResult {
  /** Rendered markdown string, or null if digest should not fire. */
  markdown: string | null;
  /** True if the digest fired (new content). */
  fired: boolean;
  /** True if user is on Pro. */
  isPro: boolean;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function digestResumePath(homeDir: string = homedir()): string {
  return join(homeDir, ".ashlr", "digest-resume-state.json");
}

// ---------------------------------------------------------------------------
// Pro detection
// ---------------------------------------------------------------------------

/**
 * True when ~/.ashlr/pro-token exists and is non-empty.
 * Same check used by the status-line.
 */
export function isProUser(homeDir: string = homedir()): boolean {
  try {
    const path = join(homeDir, ".ashlr", "pro-token");
    const st = statSync(path);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Resume state — tracks when digest was last shown in /ashlr-resume
// ---------------------------------------------------------------------------

interface DigestResumeState {
  last_digest_shown_ts: string | null; // ISO timestamp
}

export function readDigestResumeState(homeDir: string = homedir()): DigestResumeState {
  try {
    const p = digestResumePath(homeDir);
    if (!existsSync(p)) return { last_digest_shown_ts: null };
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<DigestResumeState>;
    return {
      last_digest_shown_ts:
        typeof raw.last_digest_shown_ts === "string" ? raw.last_digest_shown_ts : null,
    };
  } catch {
    return { last_digest_shown_ts: null };
  }
}

export function writeDigestResumeState(
  state: DigestResumeState,
  homeDir: string = homedir(),
): void {
  try {
    mkdirSync(join(homeDir, ".ashlr"), { recursive: true });
    writeFileSync(digestResumePath(homeDir), JSON.stringify(state, null, 2));
  } catch {
    /* best-effort */
  }
}

/** True if 7+ days have elapsed since the last digest was shown in resume. */
export function shouldShowDigestInResume(
  homeDir: string = homedir(),
  nowMs: number = Date.now(),
): boolean {
  const state = readDigestResumeState(homeDir);
  if (!state.last_digest_shown_ts) return true;
  const lastMs = Date.parse(state.last_digest_shown_ts);
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs >= 7 * 24 * 60 * 60_000;
}

// ---------------------------------------------------------------------------
// Stats reader
// ---------------------------------------------------------------------------

interface StatsFile {
  lifetime?: {
    tokensSaved?: number;
    calls?: number;
    byTool?: Record<string, { tokensSaved?: number; calls?: number }>;
    byDay?: Record<string, { tokensSaved?: number; calls?: number }>;
  };
}

function readStats(homeDir: string): StatsFile | null {
  try {
    const p = join(homeDir, ".ashlr", "stats.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as StatsFile;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "K";
  return (n / 1_000_000).toFixed(1) + "M";
}

function fmtDollars(n: number): string {
  if (!Number.isFinite(n) || n < 0.01) return "$0.00";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

// ---------------------------------------------------------------------------
// Digest section renderers
// ---------------------------------------------------------------------------

/** Render top 5 tools used this week. Returns "" when no data. */
export function renderTopToolsSection(
  byTool: Record<string, { tokensSaved?: number; calls?: number }> | undefined,
  weekTokens: number,
): string {
  if (!byTool || weekTokens <= 0) return "";
  const entries = Object.entries(byTool)
    .map(([name, v]) => ({ name, tokens: v?.tokensSaved ?? 0, calls: v?.calls ?? 0 }))
    .filter((e) => e.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  if (entries.length === 0) return "";

  const lines: string[] = ["### Top tools this week"];
  for (const e of entries) {
    const pct = weekTokens > 0 ? Math.round((e.tokens / weekTokens) * 100) : 0;
    lines.push(`- **${e.name}**: ${e.calls} calls · ${fmtTokens(e.tokens)} tokens saved (${pct}%)`);
  }
  return lines.join("\n");
}

/** Render genome learnings section. Returns "" when no genome is present. */
export function renderGenomeLearningsSection(homeDir: string): string {
  try {
    const genomePath = join(homeDir, ".ashlrcode", "genome");
    if (!existsSync(genomePath)) return "";
    // Count .md files in genome knowledge dir as a proxy for section count.
    const knowledgePath = join(genomePath, "knowledge");
    if (!existsSync(knowledgePath)) return "";
    const { readdirSync } = require("fs") as typeof import("fs");
    const files = readdirSync(knowledgePath).filter((f: string) => f.endsWith(".md"));
    if (files.length === 0) return "";
    return [
      "### Genome learnings",
      `- ${files.length} knowledge section(s) in your project genome`,
      "- Run `/ashlr-genome-init` on a new project to start capturing learnings",
    ].join("\n");
  } catch {
    return "";
  }
}

/** Render streak section. Returns "" when streak < 1. */
export function renderStreakSection(homeDir: string): string {
  try {
    const streak = readStreaks(homeDir);
    if (streak.currentStreak < 1) return "";
    const lines: string[] = ["### Streak"];
    lines.push(`- Current streak: **${streak.currentStreak}d**`);
    if (streak.longestStreak > streak.currentStreak) {
      lines.push(`- Longest streak: ${streak.longestStreak}d`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Free-tier teaser
// ---------------------------------------------------------------------------

export function renderProTeaser(): string {
  return [
    "---",
    "**Weekly digest is a Pro feature.**",
    "Pro unlocks: weekly digest with team genome learnings, shared knowledge base, and cross-machine stats.",
    "Run `/ashlr-tier` to see what Pro adds for $12/mo.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Full digest renderer
// ---------------------------------------------------------------------------

/**
 * Compute token savings for the prior ISO week from byDay data.
 */
export function computeWeekTokens(
  byDay: Record<string, { tokensSaved?: number }> | undefined,
  priorWeek: string,
): number {
  if (!byDay) return 0;
  const keys = weekDayKeys(priorWeek);
  return keys.reduce((sum, k) => sum + (byDay[k]?.tokensSaved ?? 0), 0);
}

/**
 * Render the full weekly digest markdown. Does NOT check the 7-day gate or
 * update state — that's the caller's responsibility.
 */
export function renderWeeklyDigest(opts: WeeklyDigestOpts = {}): string {
  const homeDir = opts.home ?? homedir();
  const now = opts.now ?? new Date();

  const stats = readStats(homeDir);
  const prior = priorWeekKey(now);
  const weekTokens = computeWeekTokens(stats?.lifetime?.byDay, prior);
  const weekDollars = costFor(weekTokens);

  const sections: string[] = [];

  // Header
  sections.push(`## ashlr Weekly Digest — week of ${prior}`);
  sections.push("");

  // Savings summary
  sections.push("### Savings this week");
  if (weekTokens > 0) {
    sections.push(`- **${fmtTokens(weekTokens)}** tokens saved`);
    sections.push(`- **${fmtDollars(weekDollars)}** estimated value`);
  } else {
    sections.push("- No savings recorded last week");
  }
  sections.push("");

  // Top tools
  const topTools = renderTopToolsSection(stats?.lifetime?.byTool, weekTokens);
  if (topTools) {
    sections.push(topTools);
    sections.push("");
  }

  // Genome learnings
  const genome = renderGenomeLearningsSection(homeDir);
  if (genome) {
    sections.push(genome);
    sections.push("");
  }

  // Streak
  const streakSection = renderStreakSection(homeDir);
  if (streakSection) {
    sections.push(streakSection);
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the weekly digest. Respects the 7-day gate unless force=true.
 * Marks the digest as shown (updates state) unless suppressStateWrite=true.
 */
export function buildWeeklyDigest(opts: WeeklyDigestOpts = {}): WeeklyDigestResult {
  const homeDir = opts.home ?? homedir();
  const nowMs = opts.now ? opts.now.getTime() : Date.now();

  const proUser = opts.isPro ?? isProUser(homeDir);

  // 7-day gate (unless force=true).
  if (!opts.force && !shouldShowDigestInResume(homeDir, nowMs)) {
    return { markdown: null, fired: false, isPro: proUser };
  }

  let markdown: string;
  if (proUser) {
    markdown = renderWeeklyDigest(opts);
  } else {
    markdown = renderProTeaser();
  }

  // Update state.
  if (!opts.suppressStateWrite) {
    writeDigestResumeState(
      { last_digest_shown_ts: new Date(nowMs).toISOString() },
      homeDir,
    );
  }

  return { markdown, fired: true, isPro: proUser };
}

/**
 * Integration point for /ashlr-resume: prepend the digest when 7+ days
 * have elapsed. Returns the digest markdown (or null if gated/not ready).
 */
export function getDigestForResume(
  homeDir: string = homedir(),
  nowMs: number = Date.now(),
): string | null {
  if (!shouldShowDigestInResume(homeDir, nowMs)) return null;
  const result = buildWeeklyDigest({ home: homeDir, now: new Date(nowMs) });
  return result.markdown;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const digest = buildWeeklyDigest({ force: process.argv.includes("--force") });
  if (digest.markdown) {
    process.stdout.write(digest.markdown + "\n");
  } else {
    process.stdout.write("No digest available yet (shown less than 7 days ago). Use --force to override.\n");
  }
  process.exit(0);
}
