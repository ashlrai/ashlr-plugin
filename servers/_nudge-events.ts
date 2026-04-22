/**
 * Nudge telemetry — records shown/clicked/dismissed events for the upgrade nudge.
 *
 * Writes JSONL to ~/.ashlr/nudge-events.jsonl. Kept separate from
 * session-log.jsonl because its retention needs are different (we care about
 * long-running conversion rates, not per-call observability) and because it
 * is safer to ship the backend sync on a file that isn't used by anything else.
 *
 * Privacy invariants:
 *   - sessionId is hashed before write (not the raw CLAUDE_SESSION_ID).
 *   - tokenCount is bucketed (50k / 100k / 500k / 1m) — never exact.
 *   - No cwd, no paths, no filenames, no user-supplied strings.
 *
 * Contract: every public function is best-effort; none throw.
 */

import { createHash, randomUUID } from "crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NudgeEventKind =
  | "nudge_shown"
  | "nudge_clicked"
  | "nudge_dismissed_implicitly";

export interface NudgeEvent {
  ts: string;
  event: NudgeEventKind;
  sessionId: string;
  tokenCount: number; // bucketed
  variant: string;
  nudgeId: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function home(override?: string): string {
  return override ?? process.env.HOME ?? homedir();
}

export function nudgeEventsPath(homeOverride?: string): string {
  return join(home(homeOverride), ".ashlr", "nudge-events.jsonl");
}

function sessionStatePath(homeOverride?: string): string {
  return join(home(homeOverride), ".ashlr", "nudge-session-state.json");
}

function proTokenPath(homeOverride?: string): string {
  return join(home(homeOverride), ".ashlr", "pro-token");
}

// ---------------------------------------------------------------------------
// Hashing / bucketing
// ---------------------------------------------------------------------------

/** Hash a raw session id to a short, non-reversible digest. */
export function hashSessionId(raw: string): string {
  return createHash("sha256").update(`ashlr-nudge:${raw}`).digest("hex").slice(0, 16);
}

/**
 * Map an exact token count into one of the published buckets.
 * Buckets: 0 (below-threshold), 50k, 100k, 500k, 1m.
 * Anything below 50k is 0 — we never want exact sub-threshold counts flowing
 * through the telemetry payload.
 */
export function bucketTokenCount(n: number): number {
  if (!Number.isFinite(n) || n < 50_000) return 0;
  if (n >= 1_000_000) return 1_000_000;
  if (n >= 500_000) return 500_000;
  if (n >= 100_000) return 100_000;
  return 50_000;
}

// ---------------------------------------------------------------------------
// Session-scoped dedupe state
// ---------------------------------------------------------------------------
//
// We store one small json file per session so the status line can dedupe
// nudge_shown events across its many invocations without burning a hit per
// render. The file holds the first-shown timestamp + the nudgeId so a later
// /ashlr-upgrade invocation (in the same session) can correlate to it.

interface NudgeSessionState {
  sessionHash: string;
  nudgeId: string;
  firstShownAt: string; // ISO
  lastShownAt: string;
  clicked: boolean;
  variant: string;
  tokenBucket: number;
}

const SHOWN_DEDUPE_MS = 60 * 60 * 1000; // once per hour

async function readSessionState(homeOverride?: string): Promise<NudgeSessionState | null> {
  try {
    const raw = await readFile(sessionStatePath(homeOverride), "utf-8");
    return JSON.parse(raw) as NudgeSessionState;
  } catch {
    return null;
  }
}

async function writeSessionState(s: NudgeSessionState, homeOverride?: string): Promise<void> {
  try {
    await mkdir(dirname(sessionStatePath(homeOverride)), { recursive: true });
    await writeFile(sessionStatePath(homeOverride), JSON.stringify(s));
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Append helpers
// ---------------------------------------------------------------------------

async function appendJsonl(rec: NudgeEvent, homeOverride?: string): Promise<void> {
  try {
    const p = nudgeEventsPath(homeOverride);
    await mkdir(dirname(p), { recursive: true });
    await appendFile(p, JSON.stringify(rec) + "\n", "utf-8");
  } catch { /* best-effort */ }
}

function rawSessionId(): string {
  const explicit = process.env.CLAUDE_SESSION_ID ?? process.env.ASHLR_SESSION_ID;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const seed = `ppid:${process.ppid ?? "?"}:${process.env.HOME ?? ""}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return `p${(h >>> 0).toString(16)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RecordShownOpts {
  /** Raw session id, prior to hashing. Defaults to CLAUDE_SESSION_ID / PPID fallback. */
  rawSessionId?: string;
  /** Exact token count — will be bucketed. */
  tokenCount: number;
  /** Copy variant, e.g. "v1". Default "v1". */
  variant?: string;
  /** Inject now() for tests. */
  now?: number;
  /** HOME override for tests / sandboxed renders. */
  home?: string;
}

export interface RecordShownResult {
  /** True iff a new event was written (vs. suppressed by dedupe). */
  wrote: boolean;
  /** The nudgeId the caller should use for correlation. */
  nudgeId: string;
}

/**
 * Log a nudge_shown event for the current session. Dedupes so we record
 * at most one per session per hour — the status line fires every poll tick
 * and we don't want a 50 Hz heartbeat of "nudge_shown".
 */
export async function recordNudgeShown(opts: RecordShownOpts): Promise<RecordShownResult> {
  const now = opts.now ?? Date.now();
  const sessionHash = hashSessionId(opts.rawSessionId ?? rawSessionId());
  const variant = opts.variant ?? "v1";
  const tokenBucket = bucketTokenCount(opts.tokenCount);
  const existing = await readSessionState(opts.home);

  // Same session, within dedupe window → suppress the log line but return the
  // existing nudgeId so clicks still correlate.
  if (existing && existing.sessionHash === sessionHash) {
    const lastMs = Date.parse(existing.lastShownAt);
    if (Number.isFinite(lastMs) && now - lastMs < SHOWN_DEDUPE_MS) {
      return { wrote: false, nudgeId: existing.nudgeId };
    }
    // Past the window — refresh the timestamp, reuse the nudgeId.
    const next: NudgeSessionState = {
      ...existing,
      lastShownAt: new Date(now).toISOString(),
      tokenBucket,
      variant,
    };
    await writeSessionState(next, opts.home);
    const rec: NudgeEvent = {
      ts: next.lastShownAt,
      event: "nudge_shown",
      sessionId: sessionHash,
      tokenCount: tokenBucket,
      variant,
      nudgeId: existing.nudgeId,
    };
    await appendJsonl(rec, opts.home);
    return { wrote: true, nudgeId: existing.nudgeId };
  }

  // New session → mint a nudgeId and persist state.
  const nudgeId = randomUUID();
  const nowIso = new Date(now).toISOString();
  const state: NudgeSessionState = {
    sessionHash,
    nudgeId,
    firstShownAt: nowIso,
    lastShownAt: nowIso,
    clicked: false,
    variant,
    tokenBucket,
  };
  await writeSessionState(state, opts.home);

  const rec: NudgeEvent = {
    ts: nowIso,
    event: "nudge_shown",
    sessionId: sessionHash,
    tokenCount: tokenBucket,
    variant,
    nudgeId,
  };
  await appendJsonl(rec, opts.home);
  return { wrote: true, nudgeId };
}

export interface RecordClickedOpts {
  rawSessionId?: string;
  /** Maximum correlation window (ms). Default 30 minutes. */
  windowMs?: number;
  variant?: string;
  now?: number;
  home?: string;
}

/**
 * Log a nudge_clicked event iff we can correlate it to a recent nudge_shown
 * in the same session within the window. If no shown event is present or
 * the window has elapsed, we still log an "orphan" click (nudgeId "none")
 * so the backend can spot unattributed clicks.
 */
export async function recordNudgeClicked(opts: RecordClickedOpts = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 30 * 60 * 1000;
  const sessionHash = hashSessionId(opts.rawSessionId ?? rawSessionId());
  const state = await readSessionState(opts.home);

  let nudgeId = "none";
  let tokenBucket = 0;
  let variant = opts.variant ?? "v1";
  if (state && state.sessionHash === sessionHash) {
    const shownMs = Date.parse(state.firstShownAt);
    if (Number.isFinite(shownMs) && now - shownMs <= windowMs) {
      nudgeId = state.nudgeId;
      tokenBucket = state.tokenBucket;
      variant = state.variant;
      // Mark clicked so the SessionEnd hook doesn't re-emit a dismissal.
      await writeSessionState({ ...state, clicked: true }, opts.home);
    }
  }

  const rec: NudgeEvent = {
    ts: new Date(now).toISOString(),
    event: "nudge_clicked",
    sessionId: sessionHash,
    tokenCount: tokenBucket,
    variant,
    nudgeId,
  };
  await appendJsonl(rec, opts.home);
}

/**
 * Log a nudge_dismissed_implicitly event when the session ends and a
 * nudge_shown exists but no click was recorded.
 */
export async function recordNudgeDismissedIfPending(opts: { rawSessionId?: string; now?: number; home?: string } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const sessionHash = hashSessionId(opts.rawSessionId ?? rawSessionId());
  const state = await readSessionState(opts.home);
  if (!state || state.sessionHash !== sessionHash || state.clicked) return false;

  const rec: NudgeEvent = {
    ts: new Date(now).toISOString(),
    event: "nudge_dismissed_implicitly",
    sessionId: sessionHash,
    tokenCount: state.tokenBucket,
    variant: state.variant,
    nudgeId: state.nudgeId,
  };
  await appendJsonl(rec, opts.home);
  // Clear the state file so a later session reusing the same home dir
  // doesn't double-count.
  try { await writeFile(sessionStatePath(opts.home), "{}"); } catch { /* best-effort */ }
  return true;
}

// ---------------------------------------------------------------------------
// Aggregation — used by /ashlr-savings to surface the nudge section
// ---------------------------------------------------------------------------

export interface NudgeSummary {
  shown: number;
  clicked: number;
  dismissed: number;
  conversionPct: number; // 0..100, rounded to 1 decimal; 0 when shown === 0
}

function emptySummary(): NudgeSummary {
  return { shown: 0, clicked: 0, dismissed: 0, conversionPct: 0 };
}

/**
 * Read the jsonl log and summarise it. Missing / malformed lines are skipped.
 * Never throws.
 */
export async function readNudgeSummary(homeOverride?: string): Promise<NudgeSummary> {
  const p = nudgeEventsPath(homeOverride);
  if (!existsSync(p)) return emptySummary();
  let raw = "";
  try { raw = await readFile(p, "utf-8"); } catch { return emptySummary(); }
  const s = emptySummary();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const r = JSON.parse(trimmed) as Partial<NudgeEvent>;
      if (r.event === "nudge_shown") s.shown += 1;
      else if (r.event === "nudge_clicked") s.clicked += 1;
      else if (r.event === "nudge_dismissed_implicitly") s.dismissed += 1;
    } catch { /* skip malformed */ }
  }
  s.conversionPct = s.shown > 0 ? Math.round((s.clicked / s.shown) * 1000) / 10 : 0;
  return s;
}

// ---------------------------------------------------------------------------
// Cloud sync (best-effort, opt-in via pro-token presence)
// ---------------------------------------------------------------------------

/** Epoch ms of the last sync attempt — throttles syncs to once per interval. */
let _lastSync = 0;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** Test hook — reset throttle. */
export function _resetSyncThrottle(): void { _lastSync = 0; }

async function readProToken(): Promise<string | null> {
  const env = process.env["ASHLR_PRO_TOKEN"];
  if (env && env.trim()) return env.trim();
  try {
    const raw = await readFile(proTokenPath(), "utf-8");
    const tok = raw.trim();
    return tok.length > 0 ? tok : null;
  } catch { return null; }
}

/**
 * Fire-and-forget upload of recent nudge events to the ashlr backend. Gated
 * on a valid pro-token; throttled to once per 5 minutes. Drops on any error.
 */
export function maybeSyncToCloud(opts: { now?: number } = {}): void {
  const now = opts.now ?? Date.now();
  if (process.env["ASHLR_STATS_UPLOAD"] === "0") return;
  if (now - _lastSync < SYNC_INTERVAL_MS) return;
  _lastSync = now;
  void _doSync();
}

async function _doSync(): Promise<void> {
  try {
    const token = await readProToken();
    if (!token) return;
    const p = nudgeEventsPath();
    if (!existsSync(p)) return;
    let raw = "";
    try { raw = await readFile(p, "utf-8"); } catch { return; }
    const events: NudgeEvent[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t) as NudgeEvent); } catch { /* skip */ }
    }
    if (events.length === 0) return;

    const apiUrl = process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";
    await fetch(`${apiUrl}/events/nudge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/** Wipe the session-state file; used by tests to start fresh. */
export async function _resetSessionState(homeOverride?: string): Promise<void> {
  try { await writeFile(sessionStatePath(homeOverride), "{}"); } catch { /* best-effort */ }
}

/** Prefer existsSync for callers that want to check without reading. */
export function _sessionStateExists(homeOverride?: string): boolean {
  return existsSync(sessionStatePath(homeOverride));
}

/** Exposed for tests that need to stat the jsonl (e.g. mtime assertions). */
export async function _jsonlStat(homeOverride?: string): Promise<{ size: number } | null> {
  try { const st = await stat(nudgeEventsPath(homeOverride)); return { size: st.size }; } catch { return null; }
}
