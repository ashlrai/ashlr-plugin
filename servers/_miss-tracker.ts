/**
 * _miss-tracker.ts: compression miss tracking (self-tuning P1).
 *
 * A "miss" is a compressed ashlr__read / ashlr__grep result for a target that
 * is followed by a native Read / Grep of the same target within
 * MISS_WINDOW_TURNS turns. That re-read signals the compact output was not
 * enough. Counts feed the per-repo tuner (P2).
 *
 * Privacy: local only. Targets are kept only as an 8-char hash in the
 * per-session pending file. Stats live per repo in
 * ~/.ashlr/miss-stats/<repo-hash>.json: counts keyed by ashlr tool and file
 * extension plus per-ISO-week totals (including native re-fetch bytes),
 * never paths or content.
 *
 * Off switches: ASHLR_TUNING=off or ASHLR_SESSION_LOG=0. Best-effort, never throws.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { extname, join, resolve } from "path";

import { sha8 } from "./_history-tracker";

/** A native re-read within this many turns of a compressed result counts as a miss. */
export const MISS_WINDOW_TURNS = 3;

const ASHLR_TOOLS: Record<string, "read" | "grep"> = {
  ashlr__read: "read",
  ashlr__grep: "grep",
  "mcp__ashlr-efficiency__ashlr__read": "read",
  "mcp__ashlr-efficiency__ashlr__grep": "grep",
  mcp__plugin_ashlr_ashlr__ashlr__read: "read",
  mcp__plugin_ashlr_ashlr__ashlr__grep: "grep",
};
const NATIVE_TOOLS: Record<string, "read" | "grep"> = { Read: "read", Grep: "grep" };

export interface MissCounts { compressed: number; misses: number }
/** stats[tool]["." + ext or "(none)"] */
export type MissStats = Record<string, Record<string, MissCounts>>;
export interface WeekTotals { compressed: number; misses: number; refetchBytes: number }
export interface RepoMissFile { tools: MissStats; weeks: Record<string, WeekTotals> }

/** ISO week key, e.g. "2026-W43" (UTC). */
export function isoWeek(ms: number): string {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const wk = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(wk).padStart(2, "0")}`;
}

interface Pending { t: string; tool: string; ext: string; turn: number; missed?: boolean }

// ---------------------------------------------------------------------------
// State caps (per repo). State files are untrusted input: every read is
// validated and anything malformed falls back to defaults.
// ---------------------------------------------------------------------------

/** Max extension keys per tool; the rest fold into OTHER_EXT. */
export const MAX_EXT_KEYS = 64;
/** Weekly totals kept (newest first). The report shows the last 4. */
export const MAX_WEEKS = 8;
/** Max in-window pending entries per session. */
export const MAX_PENDING = 256;
/** Any single counter is clamped to this. */
export const MAX_COUNT = 1_000_000_000;
export const OTHER_EXT = "(other)";
export const KNOWN_TOOLS: ReadonlySet<string> = new Set(["ashlr__read", "ashlr__grep"]);
const EXT_RE = /^(\.[a-z0-9_+-]{1,15}|\(none\)|\(other\))$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function safeCount(v: unknown): number {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_COUNT) : 0;
}
/** Normalize an extension key; unknown shapes become OTHER_EXT. */
export function safeExt(ext: string): string {
  const e = ext.toLowerCase();
  return EXT_RE.test(e) ? e : OTHER_EXT;
}

/** Keep the top MAX_EXT_KEYS extensions by `weight`, folding the rest into OTHER_EXT. */
export function capExtensions<T>(row: Record<string, T>, weight: (v: T) => number, merge: (a: T, b: T) => T): Record<string, T> {
  const entries = Object.entries(row);
  if (entries.length <= MAX_EXT_KEYS) return row;
  entries.sort((a, b) => weight(b[1]) - weight(a[1]));
  const out: Record<string, T> = {};
  const keep = entries.filter(([k]) => k !== OTHER_EXT).slice(0, MAX_EXT_KEYS - 1);
  for (const [k, v] of keep) out[k] = v;
  for (const [k, v] of entries) {
    if (k in out) continue;
    out[OTHER_EXT] = out[OTHER_EXT] === undefined ? v : merge(out[OTHER_EXT]!, v);
  }
  return out;
}

/** Validate and cap a parsed miss-stats file. Never throws. */
export function sanitizeRepoMissFile(raw: unknown): RepoMissFile {
  const out: RepoMissFile = { tools: {}, weeks: {} };
  if (!isPlainObject(raw)) return out;
  if (isPlainObject(raw.tools)) {
    for (const [tool, row] of Object.entries(raw.tools)) {
      if (!KNOWN_TOOLS.has(tool) || !isPlainObject(row)) continue;
      const clean: Record<string, MissCounts> = {};
      for (const [ext, c] of Object.entries(row)) {
        if (!isPlainObject(c)) continue;
        const k = safeExt(ext);
        const prev = clean[k] ?? { compressed: 0, misses: 0 };
        const compressed = Math.min(MAX_COUNT, prev.compressed + safeCount(c.compressed));
        clean[k] = { compressed, misses: Math.min(compressed, prev.misses + safeCount(c.misses)) };
      }
      out.tools[tool] = capExtensions(clean, (v) => v.compressed, (a, b) => ({
        compressed: Math.min(MAX_COUNT, a.compressed + b.compressed),
        misses: Math.min(MAX_COUNT, a.misses + b.misses),
      }));
    }
  }
  if (isPlainObject(raw.weeks)) {
    const keys = Object.keys(raw.weeks).filter((k) => WEEK_RE.test(k)).sort((a, b) => b.localeCompare(a)).slice(0, MAX_WEEKS);
    for (const k of keys) {
      const w = raw.weeks[k];
      if (!isPlainObject(w)) continue;
      out.weeks[k] = { compressed: safeCount(w.compressed), misses: safeCount(w.misses), refetchBytes: safeCount(w.refetchBytes) };
    }
  }
  return out;
}

function sanitizePending(raw: unknown): Pending[] {
  if (!Array.isArray(raw)) return [];
  const out: Pending[] = [];
  for (const e of raw) {
    if (!isPlainObject(e) || typeof e.t !== "string" || typeof e.tool !== "string" || typeof e.ext !== "string") continue;
    if (!KNOWN_TOOLS.has(e.tool) || typeof e.turn !== "number" || !Number.isFinite(e.turn)) continue;
    out.push({ t: e.t.slice(0, 8), tool: e.tool, ext: safeExt(e.ext), turn: e.turn, missed: e.missed === true });
  }
  return out.slice(-MAX_PENDING);
}

/** Why tracking and tuning are disabled, or null when enabled. */
export function trackingDisabledReason(): string | null {
  if (process.env.ASHLR_TUNING === "off") return "ASHLR_TUNING=off";
  if (process.env.ASHLR_SESSION_LOG === "0") return "ASHLR_SESSION_LOG=0";
  return null;
}

export function trackingEnabled(): boolean {
  return trackingDisabledReason() === null;
}

/** Per-repo stats file. Repo key = hash of the cwd (no path stored). */
export function missStatsPath(homeDir: string, cwd: string = process.cwd()): string {
  return join(homeDir, ".ashlr", "miss-stats", `${sha8(resolve(cwd))}.json`);
}
function pendingPath(homeDir: string, sessionId: string): string {
  return join(homeDir, ".ashlr", "miss-pending", `${sessionId}.json`);
}

/** Read and parse JSON; returns undefined on a missing file or any error. */
export function readJsonSafe(p: string): unknown {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : undefined; } catch { return undefined; }
}
/** Write state owner-only: file 0600 in a 0700 directory. */
export function writeStateJson(p: string, v: unknown): void {
  const dir = join(p, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  writeFileSync(p, JSON.stringify(v), { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* best-effort */ }
}

/** Target path from a Read/Grep or ashlr__read/ashlr__grep tool_input. */
export function targetOf(input: unknown, cwd: string = process.cwd()): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const p = i.file_path ?? i.path;
  if (typeof p !== "string" || !p.trim()) return null;
  return resolve(cwd, p);
}

export function readRepoMissFile(homeDir: string, cwd: string = process.cwd()): RepoMissFile {
  return sanitizeRepoMissFile(readJsonSafe(missStatsPath(homeDir, cwd)));
}

export function readMissStats(homeDir: string, cwd: string = process.cwd()): MissStats {
  return readRepoMissFile(homeDir, cwd).tools;
}

/**
 * Observe one completed tool call. `turn` is the session turn index of this
 * call. Returns "compressed", "miss", or null (nothing recorded).
 */
export function observeToolCall(
  toolName: string,
  toolInput: unknown,
  turn: number,
  sessionId: string,
  homeDir: string,
  cwd: string = process.cwd(),
  resultBytes = 0,
  now: number = Date.now(),
): "compressed" | "miss" | null {
  if (!trackingEnabled()) return null;
  try {
    const kind = ASHLR_TOOLS[toolName] ?? NATIVE_TOOLS[toolName];
    if (!kind) return null;
    const target = targetOf(toolInput, cwd);
    if (!target) return null;
    const t = sha8(target);
    const pp = pendingPath(homeDir, sessionId);
    const pending = sanitizePending(readJsonSafe(pp)).filter((e) => turn - e.turn <= MISS_WINDOW_TURNS);
    const file = readRepoMissFile(homeDir, cwd);
    const stats = file.tools;
    const week = (file.weeks[isoWeek(now)] ??= { compressed: 0, misses: 0, refetchBytes: 0 });
    const bump = (tool: string, ext: string, key: keyof MissCounts) => {
      const row = (stats[tool] ??= {});
      const k = row[ext] || Object.keys(row).length < MAX_EXT_KEYS ? ext : OTHER_EXT;
      const c = (row[k] ??= { compressed: 0, misses: 0 });
      c[key] = Math.min(MAX_COUNT, c[key] + 1);
    };

    let outcome: "compressed" | "miss" | null = null;
    if (ASHLR_TOOLS[toolName]) {
      const tool = `ashlr__${kind}`;
      const ext = safeExt(extname(target) || "(none)");
      pending.push({ t, tool, ext, turn });
      bump(tool, ext, "compressed");
      week.compressed++;
      outcome = "compressed";
    } else {
      const hit = pending.find((e) => e.t === t && !e.missed && e.turn < turn);
      if (hit) {
        hit.missed = true;
        bump(hit.tool, hit.ext, "misses");
        week.misses++;
        week.refetchBytes = Math.min(MAX_COUNT, week.refetchBytes + safeCount(resultBytes));
        outcome = "miss";
      }
    }
    writeStateJson(pp, pending.slice(-MAX_PENDING));
    if (outcome) {
      // Re-sanitize to prune weeks beyond MAX_WEEKS before writing.
      writeStateJson(missStatsPath(homeDir, cwd), sanitizeRepoMissFile(file));
    }
    return outcome;
  } catch {
    return null;
  }
}
