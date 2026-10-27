/**
 * _repo-savings.ts: tokens saved per repo per UTC ISO week (self-tuning).
 *
 * Recorded alongside the global stats in _stats.recordSaving, which is left
 * unchanged. Same conventions as the tuner state: repo key = hash of cwd, counts
 * only, file 0600 in a 0700 dir, fail-safe reads, last MAX_WEEKS weeks kept.
 * Disabled by ASHLR_TUNING=off or ASHLR_SESSION_LOG=0. Never throws.
 */

import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

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
  const keys = Object.keys(raw.weeks).filter((k) => WEEK_RE.test(k)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, MAX_WEEKS);
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
    const p = repoSavingsPath(homeDir, cwd);
    withLock(`${p}.lock`, () => {
      // Re-read inside the lock so concurrent writers merge instead of clobbering.
      const f = readRepoSavings(homeDir, cwd);
      const wk = isoWeek(now);
      f.weeks[wk] = safeCount((f.weeks[wk] ?? 0) + add);
      // Temp file + rename: readers never see a partial file.
      const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        writeStateJson(tmp, sanitizeRepoSavings(f));
        renameSync(tmp, p);
      } catch (e) {
        try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
        throw e;
      }
    });
  } catch {
    /* never break accounting */
  }
}

export const LOCK_TIMEOUT_MS = 250;
export const LOCK_STALE_MS = 5_000;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run fn holding an O_EXCL lock file. Waits up to LOCK_TIMEOUT_MS; a lock older
 * than LOCK_STALE_MS (crashed writer) is removed. On timeout fn still runs: the
 * write stays atomic, only a concurrent increment could be lost.
 */
export function withLock(lockPath: string, fn: () => void): void {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) { unlinkSync(lockPath); continue; }
      } catch { continue; }
      if (Date.now() >= deadline) break;
      sleepMs(5);
    }
  }
  try {
    fn();
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best-effort */ }
      try { unlinkSync(lockPath); } catch { /* best-effort */ }
    }
  }
}
