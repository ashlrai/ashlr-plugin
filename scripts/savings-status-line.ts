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

import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { c } from "./ui.ts";
import { maybeSyncToCloud, recordNudgeShown } from "../servers/_nudge-events.ts";
import { readSessionHint } from "../servers/_stats.ts";
import { costFor } from "../servers/_pricing.ts";
import {
  activityIndicator,
  detectCapability,
  frameAt,
  renderContextPressure,
  renderHeartbeat,
  renderSparkline as renderAnimatedSparkline,
  visibleWidth,
  type Capability,
} from "./ui-animation.ts";

// ---------------------------------------------------------------------------
// Stats shape (v2 schema — keyed by session id)
// ---------------------------------------------------------------------------
//
// We read the file defensively and support both the v1 shape (`session`
// singular) and the v2 shape (`sessions` map + `schemaVersion: 2`). The
// status line should never crash a terminal because stats.json is on an
// old version — we just fall back to zero.

interface ByDay { [date: string]: { calls?: number; tokensSaved?: number } }
interface SessionBucket {
  calls?: number;
  tokensSaved?: number;
  lastSavingAt?: string | null;
}
interface Stats {
  schemaVersion?: number;
  /** v2: per-session buckets keyed by CLAUDE_SESSION_ID. */
  sessions?: Record<string, SessionBucket>;
  /** v1 legacy shape — kept for readback compatibility during migration. */
  session?: SessionBucket;
  lifetime?: {
    calls?: number;
    tokensSaved?: number;
    byDay?: ByDay;
  };
}

/**
 * Candidate session ids for this process. Claude Code forwards
 * CLAUDE_SESSION_ID to status-line and hook invocations but NOT to MCP
 * server subprocesses — so the status line sees one id and the MCP servers
 * write under a different (PPID-derived) id. Returning every candidate
 * lets the status line aggregate across whichever bucket actually got
 * written.
 *
 * v1.20.2: also include the session-start hint id (~/.ashlr/last-project.json)
 * so the status line converges on the same bucket the MCP writers use when
 * neither side has CLAUDE_SESSION_ID. Without this, every Claude Code
 * session shows session=0 because writers land in the hint-id bucket while
 * the status line was looking at the ppid-id bucket.
 */
function candidateSessionIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const ids: string[] = [];
  const explicit = env.CLAUDE_SESSION_ID ?? env.ASHLR_SESSION_ID;
  if (explicit && explicit.trim().length > 0) ids.push(explicit.trim());
  const hint = readSessionHint(env.HOME ?? "");
  if (hint && !ids.includes(hint)) ids.push(hint);
  // PPID-hash fallback — matches the same shape used by servers/_stats.ts.
  const seed = `ppid:${typeof process.ppid === "number" ? process.ppid : "?"}:${env.HOME ?? ""}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  const ppidId = `p${(h >>> 0).toString(16)}`;
  if (!ids.includes(ppidId)) ids.push(ppidId);
  return ids;
}

/** Pick the first candidate id that has a bucket — for display/startedAt fields. */
function currentSessionId(env: NodeJS.ProcessEnv = process.env): string {
  return candidateSessionIds(env)[0]!;
}

/**
 * Return aggregated session counters across every candidate id the current
 * process could own, or null if no candidate bucket exists. Summing across
 * candidates ensures the status line reflects the full session even when
 * CLAUDE_SESSION_ID reached the status line but not the MCP servers (or
 * vice versa).
 */
function pickSession(stats: Stats | null, ids: string[]): SessionBucket | null {
  if (!stats) return null;
  // Primary path: sum across the v2 `sessions` map candidates.
  if (stats.sessions) {
    let calls = 0;
    let tokensSaved = 0;
    let latest: string | null = null;
    let hit = false;
    for (const id of ids) {
      const b = stats.sessions[id];
      if (!b) continue;
      hit = true;
      calls += b.calls ?? 0;
      tokensSaved += b.tokensSaved ?? 0;
      if (b.lastSavingAt && (!latest || b.lastSavingAt > latest)) latest = b.lastSavingAt;
    }
    if (hit) return { calls, tokensSaved, lastSavingAt: latest };
  }
  // Fallback: if the file is in v1 shape (zombie pre-v0.8.0 process still
  // writing), surface the v1 `session` field rather than showing 0. The v1
  // counter technically lies across concurrent terminals, but "lying
  // slightly" beats "stuck at 0" for UX. The zombie-writer scenario
  // resolves once the user fully restarts Claude Code.
  if (stats.session && typeof stats.session.tokensSaved === "number") {
    return {
      calls: stats.session.calls ?? 0,
      tokensSaved: stats.session.tokensSaved,
      lastSavingAt: null,
    };
  }
  return null;
}

interface AshlrSettings {
  statusLine?: boolean;
  statusLineSession?: boolean;
  statusLineLifetime?: boolean;
  statusLineTips?: boolean;
  statusLineSparkline?: boolean;
  /**
   * When the current session crosses ~50k tokens saved and the user is on
   * the free tier, swap the random tip for a single upgrade nudge. Default
   * true. Set false to silence the nudge entirely.
   */
  statusLineUpgradeNudge?: boolean;
}

/** Session-token threshold above which free users see the Pro upgrade nudge. */
const UPGRADE_NUDGE_THRESHOLD = 50_000;

/** Upgrade nudge copy — kept short so it fits under typical 120-col budgets. */
const UPGRADE_NUDGE_TEXT = "50k+ saved — try Pro (7d trial /ashlr-upgrade)";

/** Copy-version string. Bump when we reword UPGRADE_NUDGE_TEXT so A/B math stays honest. */
const UPGRADE_NUDGE_VARIANT = "v1";

/**
 * Lifetime-savings threshold that unlocks a one-shot celebration. We keep
 * this low on purpose — first real "ok this plugin is paying for itself"
 * moment fires around 10k tokens on most dev workflows. The celebration
 * only runs once; subsequent renders see `milestones.ten_k_reached: true`
 * in ~/.ashlr/milestones.json and stay silent.
 */
const MILESTONE_10K_THRESHOLD = 10_000;

/** Format a token count into "≈$0.04" / "≈$0.00" via shared _pricing.ts. */
function formatCost(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "≈$0.00";
  const dollars = costFor(tokens);
  if (dollars < 0.01) return "≈$0.00";
  if (dollars < 10) return `≈$${dollars.toFixed(2)}`;
  if (dollars < 1000) return `≈$${dollars.toFixed(1)}`;
  return `≈$${Math.round(dollars)}`;
}

/**
 * True when the user appears to be on Pro / Team (a local `~/.ashlr/pro-token`
 * file is written by the upgrade flow once activation succeeds). Best-effort —
 * a missing or empty file means "assume free". Never throws.
 */
function hasProToken(home: string): boolean {
  try {
    const path = join(home, ".ashlr", "pro-token");
    const st = statSync(path);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Milestone tracking. Persisted in a separate JSON file from stats.json so
 * this agent can stay out of Agent 1's stats-schema lane. Flags are flipped
 * exactly once — subsequent renders read the flag and skip the celebration.
 *
 * Shape: `{ "ten_k_reached": true }` once fired.
 */
interface Milestones {
  ten_k_reached?: boolean;
}

function readMilestones(home: string): Milestones {
  try {
    const path = join(home, ".ashlr", "milestones.json");
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Milestones;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Persist a milestone flag as a plain JSON blob. Best-effort, synchronous,
 * and wrapped in try/catch so it never blocks the status-line render path.
 * A failed write means the celebration might fire twice — acceptable
 * tradeoff vs. crashing the terminal.
 */
function writeMilestones(home: string, m: Milestones): void {
  try {
    const { mkdirSync, writeFileSync } = require("fs") as typeof import("fs");
    const dir = join(home, ".ashlr");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "milestones.json"), JSON.stringify(m));
  } catch {
    /* best-effort */
  }
}

/** Render a one-shot 10k celebration to stderr (stdout is the status line). */
function celebrate10k(home: string, stderr: NodeJS.WritableStream = process.stderr): void {
  try {
    stderr.write("🎉 10,000 tokens saved! ashlr just paid for your next coffee.\n");
  } catch {
    /* ignore — diag output is best-effort */
  }
  const current = readMilestones(home);
  writeMilestones(home, { ...current, ten_k_reached: true });
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

// ---------------------------------------------------------------------------
// Read cache (mtime-aware, 300ms TTL)
// ---------------------------------------------------------------------------
// Claude Code invokes the status line frequently (on every prompt tick).
// Re-reading + re-parsing stats.json on every call is wasteful — the status
// bar does not need sub-millisecond freshness. We cache JSON reads for 300ms
// keyed by absolute path, but a cache entry is invalidated immediately whenever
// the file's mtime changes (or its existence flips). That makes the cache
// effective under steady load (caps at ~3 reads/second) while staying correct
// across terminals: as soon as terminal A's debounce flush lands on disk (≤250ms),
// terminal B's next status-line poll sees the new mtime and re-reads.
//
// Net worst-case latency after recordSaving: 250ms debounce + 300ms TTL = 550ms.
// Typical case when mtime changes mid-window: 250ms debounce + 0ms (mtime
// invalidation fires immediately) = ~250ms.
//
// Cache is process-local — each fresh invocation of this script as a Claude
// Code subprocess starts empty; the cache only helps long-running hosts and
// within-test batch calls.
const READ_CACHE_TTL_MS = 300;
interface CacheEntry {
  at: number;
  mtimeMs: number;
  value: unknown;
}
const _readCache = new Map<string, CacheEntry>();

function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    // Missing → sentinel -1 so "absent → present" also invalidates.
    return -1;
  }
}

function readJsonCached<T>(path: string): T | null {
  const now = Date.now();
  const mtime = fileMtime(path);
  const hit = _readCache.get(path);
  if (hit && now - hit.at < READ_CACHE_TTL_MS && hit.mtimeMs === mtime) {
    return hit.value as T | null;
  }
  const fresh = readJson<T>(path);
  _readCache.set(path, { at: now, mtimeMs: mtime, value: fresh });
  return fresh;
}

/** Test hook — flush the 2s read cache. */
export function _resetReadCache(): void {
  _readCache.clear();
}

function pickTip(tips: readonly string[], seed?: number): string {
  if (tips.length === 0) return "";
  const idx = (seed ?? Math.floor(Date.now() / 86_400_000)) % tips.length;
  return tips[idx]!;
}

/**
 * Subset of the JSON payload Claude Code may send on stdin to the status-line
 * command. We try multiple field names defensively; if none resolve to a
 * positive number the context-pressure widget is hidden entirely.
 *
 * Known / candidate fields (any may be present depending on CC version):
 *   input_tokens          — tokens consumed in the current context window
 *   context_tokens        — alias used in some builds
 *   total_tokens          — alias used in some builds
 *   total_tokens_used     — alias
 *   sessionTokens         — alias
 *   context_used_tokens   — tokens used (paired with context_limit_tokens)
 *   context_limit_tokens  — total window size
 */
export interface StatusLineInput {
  input_tokens?:        number;
  context_tokens?:      number;
  total_tokens?:        number;
  total_tokens_used?:   number;
  sessionTokens?:       number;
  context_used_tokens?: number;
  context_limit_tokens?: number;
  [key: string]: unknown;
}

/** Extract a 0–100 context-pressure percentage from a CC stdin payload.
 *  Returns null when no usable field is found. */
export function extractContextPct(input: StatusLineInput | null | undefined): number | null {
  if (!input) return null;
  // Prefer the explicit used+limit pair — most precise.
  if (
    typeof input.context_used_tokens === "number" &&
    typeof input.context_limit_tokens === "number" &&
    input.context_limit_tokens > 0
  ) {
    return Math.min(100, (input.context_used_tokens / input.context_limit_tokens) * 100);
  }
  // Fall through to token-count fields — these need a known window size.
  // Claude claude-sonnet-4-6 / opus context windows are large; without a limit
  // field we cannot compute a meaningful %. Hide the widget.
  return null;
}

export interface BuildOptions {
  home?: string;
  /** Deterministic tip index, used by tests. */
  tipSeed?: number;
  /** Explicit budget override (bypasses $COLUMNS detection). */
  budget?: number;
  /** Environment to read $COLUMNS from — used by tests. */
  env?: NodeJS.ProcessEnv;
  /** Clock injection — tests pin this; production uses Date.now. */
  now?: number;
  /**
   * Parsed JSON payload from Claude Code's stdin. When present, we extract a
   * context-pressure percentage and render the ctx widget. When absent/null
   * the widget is hidden entirely (never lies).
   */
  statusLineInput?: StatusLineInput | null;
  /**
   * Test hook. When true, the status line still renders the upgrade nudge
   * but does not emit a nudge_shown telemetry event. Production callers
   * never set this; existing tests that don't care about telemetry leave
   * it undefined and rely on the HOME sandbox to isolate the log file.
   */
  suppressNudgeTelemetry?: boolean;
  /**
   * Test hook. When true, the 10k celebration is evaluated for rendering
   * but does not write the milestones.json flag and does not print to
   * stderr. Lets tests assert on render output without polluting the tmp
   * HOME or stderr.
   */
  suppressMilestoneSideEffects?: boolean;
}

export function buildStatusLine(opts: BuildOptions = {}): string {
  try {
    const home = opts.home ?? homedir();
    const env = opts.env ?? process.env;
    const budget = opts.budget ?? resolveBudget(env);
    const now = opts.now ?? Date.now();
    const settings = readJsonCached<{ ashlr?: AshlrSettings }>(
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

    const statsPath = join(home, ".ashlr", "stats.json");
    const statsExists = existsSync(statsPath);
    const stats = readJsonCached<Stats>(statsPath);
    const sessionIds = candidateSessionIds(env);
    const sess = pickSession(stats, sessionIds);
    const session = sess?.tokensSaved ?? 0;
    const lifetime = stats?.lifetime?.tokensSaved ?? 0;
    const lifetimeCalls = stats?.lifetime?.calls ?? 0;
    const lastSavingAt = sess?.lastSavingAt ?? null;
    const msSinceActive = lastSavingAt ? Math.max(0, now - Date.parse(lastSavingAt)) : Number.POSITIVE_INFINITY;

    const cap = detectCapability(env);
    const frame = frameAt(now);

    // -----------------------------------------------------------------------
    // Left edge: "ashlr" brand + heartbeat + animated sparkline
    // -----------------------------------------------------------------------
    const brandParts: string[] = ["ashlr"];
    if (showSpark) {
      // Heartbeat glyph: dim middle-dot when idle, braille-wave when active.
      brandParts.push(renderHeartbeat(frame, msSinceActive, cap));
      // 7-day sparkline. Values come from the existing lifetime.byDay map
      // so the 7-day shape stays stable across the new per-session stats.
      const keys = lastNDayKeys(7);
      const values = keys.map((k) => stats?.lifetime?.byDay?.[k]?.tokensSaved ?? 0);
      const spark = renderAnimatedSparkline({ values, frame, msSinceActive, cap });
      // Wide terminals (>100 cols) get a "7d " label before the sparkline so
      // users know at a glance what the cells represent. Under 100 cols the
      // prefix is dropped to keep things compact. Width-stable in both modes.
      const sparkPrefix = budget > 100 ? "7d " : "";
      brandParts.push(sparkPrefix + spark);
    }
    const brand = brandParts.join(" ");

    const parts: string[] = [brand];

    // Context-pressure widget — inserted between sparkline and "session +N".
    // Hidden entirely when no usable payload field is present.
    const ctxPct = extractContextPct(opts.statusLineInput);
    const ctxWidget = ctxPct !== null ? renderContextPressure(ctxPct, cap) : null;
    if (ctxWidget !== null) parts.push(ctxWidget);

    const actIndicator = activityIndicator(msSinceActive, cap);
    // Session segment gains an inline `$` cost estimate (≈$0.04) right after
    // the token counter. The cost is built from a shared per-MTok price so a
    // future module swap only changes SESSION_PRICE_PER_MTOK / the helper.
    const sessionCost = formatCost(session);
    if (showSession) {
      if (!statsExists) {
        // Stats file doesn't exist yet — waiting for the first tool call.
        // Render a distinct waiting message instead of the regular counters.
        parts.push("(waiting for first tool call)");
      } else if (stats !== null && lifetimeCalls < 5) {
        // Stats file present but very early (< 5 lifetime calls) — not
        // enough data to show meaningful counters. Render a dim hint so
        // users know the plugin is warming up (not broken).
        parts.push(`session +0 (collecting…)`);
      } else {
        // Normal path: stats file present and established (≥ 5 calls) or
        // stats is null/corrupt (falls back gracefully to +0 counters).
        parts.push(`session ${actIndicator}+${formatTokens(session)} ${sessionCost}`);
      }
    }
    if (showLifetime && statsExists && !(stats !== null && lifetimeCalls < 5))
      parts.push(`lifetime +${formatTokens(lifetime)}`);

    // One-shot 10k lifetime celebration. Fires the first time lifetime
    // crosses MILESTONE_10K_THRESHOLD; persisted in milestones.json so
    // subsequent renders stay silent. Stderr output so the status line
    // (stdout) remains a single unbroken line for Claude Code.
    //
    // Disabled by opts.suppressMilestoneSideEffects (test hook) or by the
    // ASHLR_DISABLE_MILESTONES env var (CI / debugging).
    const milestonesDisabled =
      opts.suppressMilestoneSideEffects === true ||
      (env.ASHLR_DISABLE_MILESTONES && env.ASHLR_DISABLE_MILESTONES !== "0");
    if (!milestonesDisabled) {
      const ms = readMilestones(home);
      if (!ms.ten_k_reached && lifetime >= MILESTONE_10K_THRESHOLD) {
        celebrate10k(home);
      }
    }

    let line = parts.join(" · ");

    // Drop-order under tight budget:
    //   1. Try to add the tip — drop tip first if it doesn't fit.
    //   2. If still over budget, drop the ctx widget.
    //   3. Hard-truncate as last resort.
    if (showTips) {
      // When a free-tier user crosses the session savings threshold, swap the
      // rotating tip for a single targeted upgrade nudge. `Pro token` absence
      // is the cheap tier check — good enough for a status-line hint and
      // avoids any backend round-trip on every render.
      const nudgeEnabled = cfg.statusLineUpgradeNudge ?? true;
      const showNudge =
        nudgeEnabled && session >= UPGRADE_NUDGE_THRESHOLD && !hasProToken(home);
      const tipText = showNudge ? UPGRADE_NUDGE_TEXT : pickTip(TIPS, opts.tipSeed);
      const tipLabel = showNudge ? "↑" : "tip";
      const candidate = `${line} · ${tipLabel}: ${tipText}`;
      if (visibleWidth(candidate) <= budget) {
        line = candidate;
        // Only emit telemetry when the nudge actually fits on the rendered
        // line — a truncated nudge the user never sees shouldn't count.
        if (showNudge && !opts.suppressNudgeTelemetry) {
          // Fire-and-forget: status line must never block on IO.
          // Pass `home` through so tests using a tmp $HOME stay sandboxed.
          void recordNudgeShown({
            tokenCount: session,
            variant: UPGRADE_NUDGE_VARIANT,
            home,
          });
          maybeSyncToCloud();
        }
      }
      // Otherwise drop the tip/nudge entirely (no partial rendering).
    }

    // Drop order when still over budget after tip was dropped:
    //   (a) drop cost suffix first (saves ~7 chars and is lowest-signal)
    //   (b) then drop ctx widget if still overflowing
    // Cost is cheap bookkeeping, ctx widget is higher-signal for heavy users,
    // so cost goes before ctx.
    if (visibleWidth(line) > budget) {
      const partsNoCost: string[] = [brand];
      if (ctxWidget !== null) partsNoCost.push(ctxWidget);
      if (showSession) partsNoCost.push(`session ${actIndicator}+${formatTokens(session)}`);
      if (showLifetime) partsNoCost.push(`lifetime +${formatTokens(lifetime)}`);
      line = partsNoCost.join(" · ");
    }

    // If ctx widget caused overflow (narrow terminal), rebuild without it.
    if (ctxWidget !== null && visibleWidth(line) > budget) {
      const partsNoCtx: string[] = [brand];
      if (showSession) partsNoCtx.push(`session ${actIndicator}+${formatTokens(session)}`);
      if (showLifetime) partsNoCtx.push(`lifetime +${formatTokens(lifetime)}`);
      line = partsNoCtx.join(" · ");
      // Tip + cost were already dropped above (we only reach here when over budget).
    }

    // Budget enforcement operates on VISIBLE width — ANSI escapes don't count.
    if (visibleWidth(line) > budget) {
      // Last-resort safety. A naive `line.slice()` could cut mid-ANSI and
      // leak a dangling escape that corrupts the terminal. Strip ANSI first
      // so the slice operates on visible characters only.
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
      line = stripped.slice(0, Math.max(0, budget - 1)) + "…";
    }

    return colorize(line);
  } catch {
    return "";
  }
}

/** Overlay color on a finished, length-bounded status line. */
function colorize(line: string): string {
  // Brand (green, bold) — the very first "ashlr" token.
  let out = line.replace(/^ashlr\b/, c.bold(c.brightGreen("ashlr")));
  // Savings numbers — green for positive, dim grey for the zero case.
  // The session segment may have an activity indicator glyph (possibly ANSI-
  // wrapped) between the label and the "+N" — capture it with a lazy wildcard
  // that matches ANSI escape sequences and/or a single Unicode/ASCII glyph.
  out = out.replace(/(session |lifetime )((?:\x1b\[[0-9;]*m)*[↑+]?(?:\x1b\[[0-9;]*m)*)\+([\d.]+[KM]?)/g, (_m, lbl, indicator, num) => {
    const isZero = num === "0";
    const coloredLabel = c.dim(lbl);
    const coloredNum = isZero ? c.dim(`+${num}`) : c.green(`+${num}`);
    // indicator may be empty (idle) or already ANSI-wrapped by activityIndicator.
    return `${coloredLabel}${indicator}${coloredNum}`;
  });
  // Cost suffix after the session counter — dim grey so it doesn't compete
  // with the primary token count. Matches "≈$0.04" / "≈$12" / "≈$1.2K".
  out = out.replace(/(\s)(≈\$[0-9]+(?:\.[0-9]+)?[KM]?)/g, (_m, sp, money) => `${sp}${c.dim(money)}`);
  // Tip prefix — dim cyan label, dim body.
  out = out.replace(/tip: (.+)$/, (_m, body) => `${c.cyan("tip:")} ${c.dim(body)}`);
  // Early-state hints — dim italic for collecting… and waiting messages.
  out = out.replace(/(\(collecting…\))/, (_m, s) => c.italic(c.dim(s)));
  out = out.replace(/(\(waiting for first tool call\))/, (_m, s) => c.dim(s));
  // Mid-dot separators — dim.
  out = out.replaceAll(" · ", ` ${c.dim("\u00B7")} `);
  return out;
}

// ---------------------------------------------------------------------------
// Stdin reader — non-blocking, 50ms deadline
// ---------------------------------------------------------------------------
// Claude Code may pipe a JSON payload describing the current session state.
// We read it with a hard 50ms deadline so we never stall the terminal on a
// slow or empty stdin. Returns null on timeout, parse error, or empty input.

async function readStdinPayload(): Promise<StatusLineInput | null> {
  return new Promise<StatusLineInput | null>((resolve) => {
    // Resolve null if stdin is a TTY (nothing to read) or non-readable.
    if (process.stdin.isTTY) { resolve(null); return; }

    let raw = "";
    const timer = setTimeout(() => {
      process.stdin.destroy();
      resolve(null);
    }, 50);

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => { raw += chunk; });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      if (!raw.trim()) { resolve(null); return; }
      try { resolve(JSON.parse(raw) as StatusLineInput); }
      catch { resolve(null); }
    });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

// Run as script (skip when imported by tests).
if (import.meta.main) {
  const statusLineInput = await readStdinPayload();
  process.stdout.write(buildStatusLine({ statusLineInput }) + "\n");
  process.exit(0);
}
