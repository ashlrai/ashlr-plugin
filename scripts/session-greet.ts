#!/usr/bin/env bun
/**
 * ashlr session-start greeting — renders the human-facing welcome on each
 * Claude Code session.
 *
 * Three personalities:
 *   1. First-run (no ~/.ashlr/session-state.json) → welcome box, optional
 *      Ollama detection, next-steps checklist.
 *   2. Normal run → 1-line "last session saved X tok ($Y). Lifetime: …".
 *   3. Weekly run (>=7 days since last weekly, or runCount % 20 === 0) →
 *      compact 7-day sparkline + totals + top tool, points at
 *      /ashlr:ashlr-dashboard for the full view.
 *
 * Everything is written to stderr so it surfaces in the Claude Code
 * transcript without polluting hook JSON on stdout.
 *
 * Respect:
 *   - `ASHLR_QUIET=1` — skip all output (still updates state).
 *   - `ASHLR_NO_GREET=1` — skip greeting but keep state updates.
 *   - `NO_COLOR=1` — no ANSI.
 *   - Non-TTY stderr → plain text, no boxes.
 *
 * Contract: never throws, never exits non-zero. Corrupt state file resets as
 * if first-run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { buildDigestBanner, priorWeekKey, weekDayKeys } from "../servers/_weekly-digest.ts";
import { readStreaks } from "../servers/_streaks.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PerTool {
  calls?: number;
  tokensSaved?: number;
}
interface ByTool {
  [k: string]: PerTool | undefined;
}
interface PerDay {
  calls?: number;
  tokensSaved?: number;
}
interface ByDay {
  [date: string]: PerDay | undefined;
}

interface SessionStats {
  startedAt?: string;
  calls?: number;
  tokensSaved?: number;
  byTool?: ByTool;
}
interface LifetimeStats {
  calls?: number;
  tokensSaved?: number;
  byTool?: ByTool;
  byDay?: ByDay;
}
interface Stats {
  session?: SessionStats;
  lifetime?: LifetimeStats;
}

export interface SessionState {
  firstRunAt: string;
  lastRunAt: string;
  runCount: number;
  lastWeeklySummaryAt: string;
  /**
   * When we last suggested /ashlr:ashlr-genome-init for the current cwd.
   * Keyed by cwd so the once-per-week throttle is per-project.
   */
  lastGenomeSuggestByCwd?: Record<string, string>;
}

export type Mode = "first-run" | "normal" | "weekly";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function statsPath(home: string = homedir()): string {
  return join(home, ".ashlr", "stats.json");
}

export function sessionStatePath(home: string = homedir()): string {
  return join(home, ".ashlr", "session-state.json");
}

// ---------------------------------------------------------------------------
// TTY + color detection (self-contained — don't pull in ui.ts since hooks run
// in isolated bun processes and pulling large modules would slow startup).
// ---------------------------------------------------------------------------

function stderrIsTTY(): boolean {
  return typeof process.stderr?.isTTY === "boolean" ? process.stderr.isTTY : false;
}

function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return stderrIsTTY();
}

function a(code: string, s: string): string {
  return colorEnabled() ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const c = {
  dim: (s: string) => a("2", s),
  bold: (s: string) => a("1", s),
  cyan: (s: string) => a("36", s),
  brightCyan: (s: string) => a("96", s),
  green: (s: string) => a("32", s),
  brightGreen: (s: string) => a("92", s),
  yellow: (s: string) => a("33", s),
  brightYellow: (s: string) => a("93", s),
  magenta: (s: string) => a("35", s),
  brightMagenta: (s: string) => a("95", s),
  gray: (s: string) => a("90", s),
  white: (s: string) => a("97", s),
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

import { costFor } from "../servers/_pricing";

function fmtUsd(tokens: number): string {
  // v1.22 wiring fix: use the unified _pricing.ts costFor so session-greet
  // matches /ashlr-savings + dashboard + status-line. Previously held a
  // local BLENDED_USD_PER_MTOK = 5 that drifted from the canonical rate.
  const v = costFor(tokens);
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString()}`;
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "K";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(2) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
}

// ---------------------------------------------------------------------------
// File IO — always swallow errors; the greeting is best-effort.
// ---------------------------------------------------------------------------

export function loadStats(home: string = homedir()): Stats | null {
  try {
    const p = statsPath(home);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as Stats;
  } catch {
    return null;
  }
}

/**
 * Load the session-state.json if present and well-formed. On any parse error
 * or missing required shape, return null so the caller treats this run as a
 * first-run and overwrites the corrupt file.
 */
export function loadSessionState(home: string = homedir()): SessionState | null {
  try {
    const p = sessionStatePath(home);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<SessionState>;
    // Minimum viable shape — anything less and we treat as corrupt.
    if (
      typeof raw.firstRunAt !== "string" ||
      typeof raw.lastRunAt !== "string" ||
      typeof raw.runCount !== "number" ||
      typeof raw.lastWeeklySummaryAt !== "string"
    ) {
      return null;
    }
    return {
      firstRunAt: raw.firstRunAt,
      lastRunAt: raw.lastRunAt,
      runCount: raw.runCount,
      lastWeeklySummaryAt: raw.lastWeeklySummaryAt,
      lastGenomeSuggestByCwd:
        typeof raw.lastGenomeSuggestByCwd === "object" && raw.lastGenomeSuggestByCwd !== null
          ? (raw.lastGenomeSuggestByCwd as Record<string, string>)
          : {},
    };
  } catch {
    return null;
  }
}

export function saveSessionState(state: SessionState, home: string = homedir()): void {
  try {
    const p = sessionStatePath(home);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state, null, 2));
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Decide which greeting to render.
 *
 *   - first-run: no state file, or corrupt state file.
 *   - weekly:    >=7 days since lastWeeklySummaryAt OR runCount (post-increment)
 *                is a multiple of 20. The runCount cadence makes sure heavy
 *                users who session-start many times per day still see the
 *                weekly digest at a reasonable frequency.
 *   - normal:    everything else.
 */
export function pickMode(state: SessionState | null, now: Date = new Date()): Mode {
  if (!state) return "first-run";
  const lastWeekly = Date.parse(state.lastWeeklySummaryAt);
  if (!Number.isFinite(lastWeekly)) return "weekly";
  if (now.getTime() - lastWeekly >= WEEK_MS) return "weekly";
  // runCount here is the post-increment count for THIS run. A multiple of 20
  // earns a weekly summary even if 7 days haven't elapsed.
  if (state.runCount > 0 && state.runCount % 20 === 0) return "weekly";
  return "normal";
}

// ---------------------------------------------------------------------------
// Ollama detection
// ---------------------------------------------------------------------------

/**
 * Best-effort Ollama check. Uses curl because it's ubiquitous and we don't
 * want to pull a fetch() into a hot hook path. 2-second timeout is enough to
 * either connect to localhost or bail.
 */
export function detectOllama(): boolean {
  try {
    const res = spawnSync(
      "curl",
      ["-s", "--max-time", "2", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:11434/api/tags"],
      { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    );
    if (res.status !== 0) return false;
    const code = (res.stdout?.toString() ?? "").trim();
    return code === "200";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Genome detection (for "run genome-init?" nudge)
// ---------------------------------------------------------------------------

export function hasGenome(cwd: string = process.cwd()): boolean {
  try {
    return existsSync(join(cwd, ".ashlrcode", "genome"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max <= 0) return SPARK[0]!.repeat(values.length);
  return values
    .map((v) => {
      if (v <= 0) return c.gray(SPARK[0]!);
      const idx = Math.max(1, Math.min(7, Math.ceil((v / max) * 7)));
      const glyph = SPARK[idx]!;
      if (idx <= 2) return c.cyan(glyph);
      if (idx <= 5) return c.brightCyan(glyph);
      return c.brightGreen(glyph);
    })
    .join("");
}

function lastNDayKeys(n: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Whether we should render the fancy box-drawing UI vs. plain text. */
function fancyMode(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return stderrIsTTY();
}

/**
 * First-run welcome. In fancy mode, renders a bordered box. In non-TTY mode,
 * prints a compact plain-text version.
 */
export function renderFirstRun(opts: { ollama: boolean; hasGenome: boolean }): string {
  const lines: string[] = [];

  if (fancyMode()) {
    // Wide enough to accommodate the longest line without wrapping. 66 cols
    // fits the "Ollama detected — try /ashlr:ashlr-genome-init --summarize"
    // hint plus the leading "  ✓ " badge.
    const W = 66;
    const h = (s: string) => c.cyan(s);
    const titleBlock = " " + c.bold(c.brightCyan("Welcome to ashlr")) + " ";
    // "Welcome to ashlr" is 16 chars visible, plus two flanking spaces = 18.
    const titleVisible = 18;
    const dashes = W - 2 - titleVisible;
    const leftDashes = Math.max(2, Math.floor(dashes / 2));
    const rightDashes = Math.max(2, dashes - leftDashes);
    const top =
      h("╔") + h("═".repeat(leftDashes)) + titleBlock + h("═".repeat(rightDashes)) + h("╗");
    const bot = h("╚" + "═".repeat(W - 2) + "╝");
    const pad = (s: string): string => {
      // visibleLen — strip ANSI
      const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
      const rem = W - 4 - visible;
      return h("║") + " " + s + (rem > 0 ? " ".repeat(rem) : "") + " " + h("║");
    };
    const blank = pad("");
    lines.push(top);
    lines.push(blank);
    lines.push(pad(c.dim("Token-efficient Claude Code plugin")));
    lines.push(blank);
    lines.push(pad(c.green("  •") + " " + c.white("ashlr__read") + c.dim("  snipCompact truncation")));
    lines.push(pad(c.green("  •") + " " + c.white("ashlr__grep") + c.dim("  genome RAG retrieval")));
    lines.push(pad(c.green("  •") + " " + c.white("ashlr__edit") + c.dim("  diff-format edits")));
    lines.push(blank);
    lines.push(pad(c.bold("Next steps:")));
    if (!opts.hasGenome) {
      lines.push(pad(c.brightMagenta("  →") + " Run " + c.white("/ashlr:ashlr-genome-init") + c.dim(" in a project")));
    } else {
      lines.push(pad(c.brightMagenta("  →") + " " + c.dim("Genome detected — you're all set.")));
    }
    lines.push(pad(c.brightMagenta("  →") + " Run " + c.white("/ashlr:ashlr-dashboard") + c.dim(" to see savings")));
    lines.push(pad(c.brightMagenta("  →") + " Run " + c.white("/ashlr:ashlr-tour") + c.dim(" for a 60s walkthrough")));
    lines.push(blank);
    if (opts.ollama) {
      lines.push(
        pad(
          c.brightGreen("  ✓") +
            " " +
            c.dim("Ollama detected — try ") +
            c.white("/ashlr:ashlr-genome-init --summarize"),
        ),
      );
    } else {
      lines.push(
        pad(
          c.cyan("  ℹ") +
            " " +
            c.dim("Optional: install Ollama + ") +
            c.white("llama3.2:3b") +
            c.dim(" for local"),
        ),
      );
      lines.push(pad(c.dim("    LLM summaries — see ") + c.white("/ashlr:ashlr-ollama-setup")));
    }
    lines.push(blank);
    lines.push(bot);
  } else {
    // Plain-text fallback — no boxes, no colors (already disabled by TTY check).
    lines.push("Welcome to ashlr — token-efficient Claude Code plugin");
    lines.push("  • ashlr__read — snipCompact truncation");
    lines.push("  • ashlr__grep — genome RAG retrieval");
    lines.push("  • ashlr__edit — diff-format edits");
    lines.push("Next steps:");
    if (!opts.hasGenome) {
      lines.push("  → Run /ashlr:ashlr-genome-init in a project");
    }
    lines.push("  → Run /ashlr:ashlr-dashboard to see savings");
    lines.push("  → Run /ashlr:ashlr-tour for a 60s walkthrough");
    if (opts.ollama) {
      lines.push("  ✓ Ollama detected — try /ashlr:ashlr-genome-init --summarize");
    } else {
      lines.push("  ℹ Optional: install Ollama + llama3.2:3b — see /ashlr:ashlr-ollama-setup");
    }
  }

  return lines.join("\n");
}

/**
 * Normal-run 1-liner. Shows the delta from last session + lifetime totals.
 *
 * "Last session" means the totals currently in stats.json under `session`
 * — the efficiency server resets that block per-session, so at SessionStart
 * time it still reflects the PREVIOUS session's work.
 */
export function renderNormal(stats: Stats | null): string {
  const lifeTok = stats?.lifetime?.tokensSaved ?? 0;
  const sessTok = stats?.session?.tokensSaved ?? 0;

  if (lifeTok === 0 && sessTok === 0) {
    // No usage yet — give them a gentle poke rather than a blank stat.
    return c.brightMagenta("ashlr") + c.dim(" ⏵ ") + c.dim("no savings yet — try ") + c.white("ashlr__read") + c.dim(" on any file.");
  }

  const prefix = c.brightMagenta("ashlr") + c.dim(" ⏵ ");
  const sessionPart =
    sessTok > 0
      ? c.dim("last session saved ") +
        c.brightGreen(fmtTokens(sessTok) + " tok") +
        c.dim(" (") +
        c.brightYellow(fmtUsd(sessTok)) +
        c.dim(").")
      : c.dim("no savings last session.");
  const lifetimePart =
    c.dim(" Lifetime: ") +
    c.brightGreen(fmtTokens(lifeTok)) +
    c.dim(" (") +
    c.brightYellow(fmtUsd(lifeTok)) +
    c.dim(").");
  return prefix + sessionPart + lifetimePart;
}

/**
 * Weekly compact dashboard — 7-day sparkline + totals + top tool, and a
 * pointer to the full /ashlr:ashlr-dashboard.
 */
export function renderWeekly(stats: Stats | null, now: Date = new Date()): string {
  const byDay = stats?.lifetime?.byDay ?? {};
  const keys = lastNDayKeys(7, now);
  const values = keys.map((k) => byDay[k]?.tokensSaved ?? 0);
  const weekTotal = values.reduce((s, v) => s + v, 0);
  const activeDays = values.filter((v) => v > 0).length;

  // Top tool by lifetime tokens saved — quickest way to surface "what's
  // actually working for you".
  const byTool = stats?.lifetime?.byTool ?? {};
  let topName = "";
  let topTok = 0;
  for (const [name, t] of Object.entries(byTool)) {
    const tok = t?.tokensSaved ?? 0;
    if (tok > topTok) {
      topTok = tok;
      topName = name;
    }
  }

  const lines: string[] = [];
  if (fancyMode()) {
    lines.push(c.brightMagenta("ashlr") + c.dim(" ⏵ ") + c.bold(c.brightCyan("Weekly summary")));
    lines.push("  " + sparkline(values) + c.dim("   last 7 days"));
    lines.push(
      "  " +
        c.dim("total   ") +
        c.brightGreen(fmtTokens(weekTotal).padStart(8)) +
        c.dim("   ") +
        c.brightYellow(fmtUsd(weekTotal)),
    );
    lines.push(
      "  " +
        c.dim("active  ") +
        c.white(String(activeDays).padStart(8)) +
        c.dim(" days of 7"),
    );
    if (topName) {
      lines.push(
        "  " +
          c.dim("top     ") +
          c.white(topName.padStart(16)) +
          c.dim("  ") +
          c.brightGreen(fmtTokens(topTok)),
      );
    }
    lines.push("  " + c.dim("full view: ") + c.white("/ashlr:ashlr-dashboard"));
  } else {
    lines.push(`ashlr ⏵ weekly: ${fmtTokens(weekTotal)} tok (${fmtUsd(weekTotal)}) over ${activeDays}/7 days` +
      (topName ? ` · top: ${topName} (${fmtTokens(topTok)})` : "") +
      " · /ashlr:ashlr-dashboard for full view");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Genome-init suggestion (once per week per cwd)
// ---------------------------------------------------------------------------

export function maybeGenomeSuggestion(
  state: SessionState,
  cwd: string,
  now: Date = new Date(),
): { suggest: boolean; stateMutated: SessionState } {
  // Only relevant after the user has taken a few sessions to settle in.
  if (state.runCount <= 2) return { suggest: false, stateMutated: state };
  if (hasGenome(cwd)) return { suggest: false, stateMutated: state };

  const table = { ...(state.lastGenomeSuggestByCwd ?? {}) };
  const last = table[cwd];
  if (last) {
    const ts = Date.parse(last);
    if (Number.isFinite(ts) && now.getTime() - ts < WEEK_MS) {
      return { suggest: false, stateMutated: state };
    }
  }
  table[cwd] = now.toISOString();
  return {
    suggest: true,
    stateMutated: { ...state, lastGenomeSuggestByCwd: table },
  };
}

function renderGenomeSuggestion(cwd: string): string {
  const short = cwd.replace(homedir(), "~");
  return (
    c.cyan("ashlr ⏵ ") +
    c.dim("no genome in ") +
    c.white(short) +
    c.dim(" — run ") +
    c.white("/ashlr:ashlr-genome-init") +
    c.dim(" for ~84% grep savings.")
  );
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface GreetOpts {
  home?: string;
  cwd?: string;
  now?: Date;
  /** For tests — swap in a canned stats object instead of reading disk. */
  stats?: Stats | null;
  /** For tests — skip the real ollama probe. */
  ollamaDetector?: () => boolean;
  /** For tests — capture output instead of writing to stderr. */
  write?: (s: string) => void;
}

export interface GreetResult {
  mode: Mode;
  printed: boolean;
  genomeSuggested: boolean;
  state: SessionState;
}

/**
 * The business end: pick a mode, write the appropriate greeting, update the
 * session-state file. Returns a structured result for testing + logging.
 */
export function greet(opts: GreetOpts = {}): GreetResult {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? new Date();
  const write = opts.write ?? ((s: string) => process.stderr.write(s));

  const quiet = process.env.ASHLR_QUIET === "1";
  const noGreet = process.env.ASHLR_NO_GREET === "1";

  const stats = opts.stats !== undefined ? opts.stats : loadStats(home);
  const prior = loadSessionState(home);

  let mode: Mode;
  let nextState: SessionState;

  if (!prior) {
    mode = "first-run";
    nextState = {
      firstRunAt: now.toISOString(),
      lastRunAt: now.toISOString(),
      runCount: 1,
      lastWeeklySummaryAt: now.toISOString(),
      lastGenomeSuggestByCwd: {},
    };
  } else {
    const nextCount = prior.runCount + 1;
    // Preliminary state (runCount bumped) so pickMode sees the right count.
    const interim: SessionState = {
      ...prior,
      lastRunAt: now.toISOString(),
      runCount: nextCount,
    };
    mode = pickMode(interim, now);
    nextState = interim;
    if (mode === "weekly") {
      nextState = { ...nextState, lastWeeklySummaryAt: now.toISOString() };
    }
  }

  let printed = false;
  let genomeSuggested = false;

  if (!quiet && !noGreet) {
    if (mode === "first-run") {
      const ollama = (opts.ollamaDetector ?? detectOllama)();
      write(renderFirstRun({ ollama, hasGenome: hasGenome(cwd) }) + "\n");
      printed = true;
    } else if (mode === "weekly") {
      write(renderWeekly(stats, now) + "\n");
      printed = true;
    } else {
      write(renderNormal(stats) + "\n");
      printed = true;
    }

    // Optional per-cwd genome nudge (excluded on first-run to avoid overload).
    if (mode !== "first-run") {
      const g = maybeGenomeSuggestion(nextState, cwd, now);
      if (g.suggest) {
        write(renderGenomeSuggestion(cwd) + "\n");
        genomeSuggested = true;
      }
      nextState = g.stateMutated;
    }

    // Weekly digest banner — fires once per ISO week when savings > $0.
    // Rendered after the normal greet so it's the last thing in the transcript.
    if (mode !== "first-run") {
      try {
        const prior = priorWeekKey(now);
        const dayKeys = weekDayKeys(prior);
        const byDay = stats?.lifetime?.byDay ?? {};
        const weekTokens = dayKeys.reduce(
          (sum: number, k: string) => sum + ((byDay[k]?.tokensSaved) ?? 0),
          0,
        );
        const dollarsSaved = costFor(weekTokens);
        const streakData = readStreaks(home);
        const digest = buildDigestBanner({
          home,
          now,
          // Cast through unknown: local ByDay/ByTool index values are `T | undefined`
          // while DigestStats expects `T` — structurally compatible at runtime.
          stats: { lifetime: {
            byDay: stats?.lifetime?.byDay as Record<string, { tokensSaved?: number }> | undefined,
            byTool: stats?.lifetime?.byTool as Record<string, { tokensSaved?: number }> | undefined,
          } },
          dollarsSaved,
          currentStreak: streakData.currentStreak,
        });
        if (digest.banner) {
          write("\n" + digest.banner + "\n");
        }
      } catch {
        /* digest is decoration — never break the greeting */
      }
    }
  }

  // Always persist state — even under ASHLR_QUIET — so the first-run detector
  // remains accurate.
  saveSessionState(nextState, home);

  return { mode, printed, genomeSuggested, state: nextState };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    greet();
  } catch {
    // Swallow — greeting must never break session startup.
  }
  process.exit(0);
}
