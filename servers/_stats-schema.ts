/** Stats shapes, defaults, and legacy migration. */
export interface PerTool { calls: number; tokensSaved: number }
export interface ByTool { [k: string]: PerTool }
export interface ByDay  { [date: string]: { calls: number; tokensSaved: number } }

/** Per-session bucket. One per live CLAUDE_SESSION_ID. */
export interface SessionBucket {
  startedAt: string;
  /** ISO timestamp of the most recent recordSaving - drives the status-line animation pulse. */
  lastSavingAt: string | null;
  calls: number;
  tokensSaved: number;
  byTool: ByTool;
  /** v1.34: measured savings (optional, absent on pre-v1.34 buckets). */
  tokensSavedMeasured?: number;
  measuredCalls?: number;
}

export interface LifetimeBucket {
  calls: number;
  tokensSaved: number;
  /**
   * Raw token equivalent of every source payload that fed a recordSaving
   * call - the denominator for a `ratio = tokensSaved / rawTotal` display.
   *
   * Added in v1.18 for defensible "% savings" reporting. Optional so that
   * callers constructing a LifetimeBucket literal (tests, fixtures) don't
   * have to be updated - missing field is treated as 0 by every reader.
   * migrateToV2() populates it from on-disk data when present.
   */
  rawTotal?: number;
  byTool: ByTool;
  byDay: ByDay;
  /** v1.34: measured savings (optional, absent on pre-v1.34 files). */
  tokensSavedMeasured?: number;
  measuredCalls?: number;
}

export interface SummarizationStats {
  calls: number;
  cacheHits: number;
}

/**
 * Sparse map keyed by UTC `YYYY-MM-DD`. Only days with at least one
 * successful ashlr tool invocation appear. Used by the WAD-D north-star
 * metric (weekly-active-developers-using-it-daily).
 */
export interface DailyActiveMap {
  [date: string]: true;
}

/** On-disk shape. schemaVersion lets us migrate without breaking older clients. */
export interface StatsFile {
  schemaVersion: 2;
  sessions: { [sessionId: string]: SessionBucket };
  lifetime: LifetimeBucket;
  summarization?: SummarizationStats;
  /**
   * WAD-D: ISO timestamp set on the first ashlr tool success ever observed
   * on this machine. Never overwritten once set.
   * Older stats.json files (pre-WAD-D) lack this field, treated as unset
   * and populated on next save.
   */
  user_first_active_at?: string;
  /**
   * WAD-D: ISO timestamp of the most recent ashlr tool success on this
   * machine. Updated on every recordSaving call.
   */
  user_last_active_at?: string;
  /**
   * WAD-D: sparse map of UTC dates the machine has had >=1 success on.
   * Drives the once-per-UTC-day heartbeat to /stats/daily-active.
   */
  daily_active?: DailyActiveMap;
  /**
   * WAD-D lead indicator: ISO timestamp set when the /ashlr-start
   * onboarding wizard completes the final step. Never overwritten once set.
   */
  onboarding_completed_at?: string;
  /**
   * WAD-D lead indicator: ISO timestamp of the first recordSaving call
   * whose tokensSaved cleared a meaningful threshold (currently 100 raw
   * tokens). Never overwritten once set. Used to compute the
   * first-savings-within-30-min cohort rate server-side.
   */
  first_savings_at?: string;
  /**
   * WAD-D lead indicator: total /ashlr-savings slash-command invocations
   * grouped by ISO-week key (e.g. "2026-W21"). Sparse map; weeks with no
   * invocations are absent. Drives the "savings invocations per active
   * user per week" lever. Aggregator reads the current ISO-week count.
   */
  savings_invocations_by_week?: { [isoWeek: string]: number };
}

function emptyTools(): ByTool { return {}; }

export function emptySession(startedAt = new Date().toISOString()): SessionBucket {
  return { startedAt, lastSavingAt: null, calls: 0, tokensSaved: 0, byTool: emptyTools() };
}

function emptyLifetime(): LifetimeBucket {
  return { calls: 0, tokensSaved: 0, rawTotal: 0, byTool: emptyTools(), byDay: {} };
}

export function emptyStats(): StatsFile {
  return { schemaVersion: 2, sessions: {}, lifetime: emptyLifetime() };
}


/**
 * UTC ISO-week key (e.g. "2026-W21"). Week 01 is the week containing the
 * first Thursday of the year (ISO 8601). Used to bucket
 * /ashlr-savings invocations per week.
 */
export function currentIsoWeek(d: Date = new Date()): string {
  // Clone to a copy at UTC midnight so we don't mutate the caller's Date.
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO weekday: Mon=1 ... Sun=7. JS getUTCDay: Sun=0 ... Sat=6.
  const dayNum = (dt.getUTCDay() + 6) % 7 + 1;
  // Thursday of the current ISO week.
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/**
 * WAD-D lead indicator threshold: a recordSaving call with at least this
 * many raw saved tokens (the *output* of the savings math, post-/4 divide)
 * counts as "meaningful" - sets first_savings_at the first time it fires.
 *
 * 100 tokens ~= one decent compressed grep result; not a noise-level event.
 */
export const FIRST_SAVINGS_THRESHOLD_TOKENS = 100;

// ---------------------------------------------------------------------------
// Migration (v1 → v2)
// ---------------------------------------------------------------------------

/**
 * Accept any prior shape and coerce to v2. Never throws; returns an empty
 * file on unreadable input rather than losing data silently.
 *
 * v1 shape (in the wild): { session: {...}, lifetime: {...} }
 * v2 shape:               { schemaVersion: 2, sessions: {...}, lifetime: {...} }
 */
export function migrateToV2(raw: unknown): StatsFile {
  if (!raw || typeof raw !== "object") return emptyStats();
  const r = raw as Partial<StatsFile> & { session?: Partial<SessionBucket>; summarization?: SummarizationStats };
  if (r.schemaVersion === 2 && r.sessions && r.lifetime) {
    const out: StatsFile = {
      schemaVersion: 2,
      sessions: coerceSessions(r.sessions),
      lifetime: coerceLifetime(r.lifetime),
      summarization: r.summarization,
    };
    applyWaddFields(out, r);
    return out;
  }
  // v1 → v2: lifetime carries over; legacy global `session` is discarded
  // because it was never accurate across concurrent terminals anyway.
  // Pre-WAD-D files just lack the new fields - applyWaddFields() leaves
  // them undefined so bump() can populate them on the next save.
  const out: StatsFile = {
    schemaVersion: 2,
    sessions: {},
    lifetime: coerceLifetime(r.lifetime),
    summarization: r.summarization,
  };
  applyWaddFields(out, r);
  return out;
}

/**
 * Copy WAD-D top-level fields (user_first_active_at, user_last_active_at,
 * daily_active) from a partial on-disk shape onto a freshly-coerced StatsFile.
 * Tolerant of missing/malformed fields - older stats.json files predate
 * WAD-D and lack them; bump() will populate on next recordSaving.
 */
function applyWaddFields(
  out: StatsFile,
  r: Partial<StatsFile> & Record<string, unknown>,
): void {
  if (typeof r.user_first_active_at === "string" && r.user_first_active_at.length > 0) {
    out.user_first_active_at = r.user_first_active_at;
  }
  if (typeof r.user_last_active_at === "string" && r.user_last_active_at.length > 0) {
    out.user_last_active_at = r.user_last_active_at;
  }
  if (r.daily_active && typeof r.daily_active === "object" && !Array.isArray(r.daily_active)) {
    const da: DailyActiveMap = {};
    for (const [k, v] of Object.entries(r.daily_active as Record<string, unknown>)) {
      // Only accept "YYYY-MM-DD" keys with value === true.
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && v === true) {
        da[k] = true;
      }
    }
    if (Object.keys(da).length > 0) out.daily_active = da;
  }
  if (typeof r.onboarding_completed_at === "string" && r.onboarding_completed_at.length > 0) {
    out.onboarding_completed_at = r.onboarding_completed_at;
  }
  if (typeof r.first_savings_at === "string" && r.first_savings_at.length > 0) {
    out.first_savings_at = r.first_savings_at;
  }
  if (
    r.savings_invocations_by_week &&
    typeof r.savings_invocations_by_week === "object" &&
    !Array.isArray(r.savings_invocations_by_week)
  ) {
    const wk: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.savings_invocations_by_week as Record<string, unknown>)) {
      // Accept ISO-week keys like "2026-W21".
      if (/^\d{4}-W\d{2}$/.test(k) && typeof v === "number" && Number.isFinite(v) && v >= 0) {
        wk[k] = Math.floor(v);
      }
    }
    if (Object.keys(wk).length > 0) out.savings_invocations_by_week = wk;
  }
}

function coerceSessions(v: unknown): { [id: string]: SessionBucket } {
  if (!v || typeof v !== "object") return {};
  const out: { [id: string]: SessionBucket } = {};
  for (const [id, bucket] of Object.entries(v as Record<string, unknown>)) {
    const b = (bucket ?? {}) as Partial<SessionBucket>;
    out[id] = {
      startedAt: typeof b.startedAt === "string" ? b.startedAt : new Date().toISOString(),
      lastSavingAt: typeof b.lastSavingAt === "string" ? b.lastSavingAt : null,
      calls: numOr0(b.calls),
      tokensSaved: numOr0(b.tokensSaved),
      byTool: coerceByTool(b.byTool),
    };
    const sm = numOr0(b.tokensSavedMeasured);
    if (sm > 0) out[id]!.tokensSavedMeasured = sm;
    const mc = numOr0(b.measuredCalls);
    if (mc > 0) out[id]!.measuredCalls = mc;
  }
  return out;
}

function coerceLifetime(v: unknown): LifetimeBucket {
  const l = (v ?? {}) as Partial<LifetimeBucket>;
  const out: LifetimeBucket = {
    calls: numOr0(l.calls),
    tokensSaved: numOr0(l.tokensSaved),
    byTool: coerceByTool(l.byTool),
    byDay: coerceByDay(l.byDay),
  };
  // v1.18: rawTotal is optional. Only set it when present + non-zero so
  // reads of legacy files stay byte-equal (no spurious rawTotal:0 tag in
  // the in-memory shape that wasn't on disk).
  const rt = numOr0(l.rawTotal);
  if (rt > 0) out.rawTotal = rt;
  const ltsm = numOr0(l.tokensSavedMeasured);
  if (ltsm > 0) out.tokensSavedMeasured = ltsm;
  const ltmc = numOr0(l.measuredCalls);
  if (ltmc > 0) out.measuredCalls = ltmc;
  return out;
}

function coerceByTool(v: unknown): ByTool {
  if (!v || typeof v !== "object") return {};
  const out: ByTool = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const p = (val ?? {}) as Partial<PerTool>;
    out[k] = { calls: numOr0(p.calls), tokensSaved: numOr0(p.tokensSaved) };
  }
  return out;
}

function coerceByDay(v: unknown): ByDay {
  if (!v || typeof v !== "object") return {};
  const out: ByDay = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const p = (val ?? {}) as { calls?: number; tokensSaved?: number };
    out[k] = { calls: numOr0(p.calls), tokensSaved: numOr0(p.tokensSaved) };
  }
  return out;
}

function numOr0(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }

