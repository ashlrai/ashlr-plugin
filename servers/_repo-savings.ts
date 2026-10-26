/**
 * _repo-savings.ts: tokens saved per repo per UTC ISO week (self-tuning).
 *
 * Recorded alongside the global stats in _stats.recordSaving, which is left
 * unchanged. Same conventions as the tuner state: repo key = hash of cwd, counts
 * only, file 0600 in a 0700 dir, fail-safe reads, last MAX_WEEKS weeks kept.
 * Disabled by ASHLR_TUNING=off or ASHLR_SESSION_LOG=0. Never throws.
 */

import { homedir } from "os";
import { join, resolve } from "path";

import { sha8 } from "./_history-tracker";
import { isoWeek, isPlainObject, MAX_WEEKS, readJsonSafe, safeCount, trackingEnabled, writeStateJson } from "./_miss-tracker";

const WEEK_RE = /^\d{4}-W\d{2}$/;

/** weeks[isoWeek] = tokens saved in this repo that week. */
export interface RepoSavingsFile { weeks: Record<string, number> }

function home(): string {
  return process.env.ASHLR_HOME_OVERRIDE?.trim() || process.env.HOME || homedir();
}

export function repoSavingsPath(homeDir: string, cwd: string = process.cwd()): string {
  return join(homeDir, ".ashlr", "repo-savings", `${sha8(resolve(cwd))}.json`);
}

/** Validate and trim a parsed file (untrusted input). */
export function sanitizeRepoSavings(raw: unknown): RepoSavingsFile {
  const out: RepoSavingsFile = { weeks: {} };
  if (!isPlainObject(raw) || !isPlainObject(raw.weeks)) return out;
  const keys = Object.keys(raw.weeks).filter((k) => WEEK_RE.test(k)).sort().reverse().slice(0, MAX_WEEKS);
  for (const k of keys) out.weeks[k] = safeCount(raw.weeks[k]);
  return out;
}

export function readRepoSavings(homeDir: string = home(), cwd: string = process.cwd()): RepoSavingsFile {
  try { return sanitizeRepoSavings(readJsonSafe(repoSavingsPath(homeDir, cwd))); } catch { return { weeks: {} }; }
}

/** Add `tokensSaved` to this repo's current UTC week. Best-effort. */
export function recordRepoSaving(
  tokensSaved: number,
  homeDir: string = home(),
  cwd: string = process.cwd(),
  now: number = Date.now(),
): void {
  try {
    if (!trackingEnabled()) return;
    const add = safeCount(tokensSaved);
    if (add === 0) return;
    const f = readRepoSavings(homeDir, cwd);
    const wk = isoWeek(now);
    f.weeks[wk] = safeCount((f.weeks[wk] ?? 0) + add);
    writeStateJson(repoSavingsPath(homeDir, cwd), sanitizeRepoSavings(f));
  } catch {
    /* never break accounting */
  }
}
