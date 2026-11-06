/**
 * _repo-savings.ts: tokens saved per repo per UTC ISO week (self-tuning).
 *
 * Recorded alongside the global stats in _stats.recordSaving, which is left
 * unchanged. Same conventions as the tuner state: repo key = hash of cwd, counts
 * only, file 0600 in a 0700 dir, fail-safe reads, last MAX_WEEKS weeks kept.
 * Disabled by ASHLR_TUNING=off or ASHLR_SESSION_LOG=0. Never throws.
 */

import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, unlinkSync, type BigIntStats } from "fs";
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

const regularLock = (stat: BigIntStats) => stat.isFile() && stat.nlink === 1n && stat.ino > 0n;
const sameLock = (a: BigIntStats, b: BigIntStats) => regularLock(a) && regularLock(b) && a.dev === b.dev && a.ino === b.ino;
/** @internal A refreshed same-inode lock is not the captured stale lease. */
export function unchangedStaleLock(before: BigIntStats, current: BigIntStats, now: number): boolean {
  return sameLock(before, current) && before.mtimeNs === current.mtimeNs && before.ctimeNs === current.ctimeNs &&
    BigInt(now) - current.mtimeMs > BigInt(LOCK_STALE_MS);
}
const lockStat = (path: string): BigIntStats | undefined => {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};

/**
 * Run fn holding an O_EXCL lock file. Waits up to LOCK_TIMEOUT_MS; a lock older
 * than LOCK_STALE_MS (crashed writer) is removed. On timeout or a non-contention
 * error fn still runs: the write stays atomic, only a concurrent increment could
 * be lost.
 */
export function withLock(lockPath: string, fn: () => void): void {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;
  let identity: BigIntStats | undefined;
  while (fd === null) {
    try {
      const before = lockStat(lockPath);
      if (before) {
        // Some Windows runtimes return a descriptor for wx on a dangling
        // junction. Never try to create through any pre-existing nonregular
        // name, and never classify its target's age as an abandoned lock.
        if (!regularLock(before)) break;
        if (BigInt(Date.now()) - before.mtimeMs > BigInt(LOCK_STALE_MS)) {
          const current = lockStat(lockPath);
          if (current && unchangedStaleLock(before, current, Date.now())) unlinkSync(lockPath);
        }
      } else {
        const candidate = openSync(lockPath, "wx", 0o600);
        try {
          const opened = fstatSync(candidate, { bigint: true });
          const current = lockStat(lockPath);
          if (!current || !sameLock(opened, current)) break;
          fd = candidate;
          identity = opened;
        } finally { if (fd === null) closeSync(candidate); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") break;
    }
    if (fd !== null) break;
    // Every refusal/race preserves the original monotonic wait bound. A failed
    // acquisition still uses the documented best-effort atomic write below.
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    sleepMs(Math.min(5, remaining));
  }
  try {
    fn();
  } finally {
    if (fd !== null) {
      try {
        // Retain the owned handle through inspection/unlink: closing first can
        // free its inode for an unrelated replacement to reuse.
        const current = lockStat(lockPath);
        if (identity && current && sameLock(identity, current)) unlinkSync(lockPath);
      } catch { /* Never remove a foreign/replaced name during cleanup. */ }
      finally { try { closeSync(fd); } catch { /* best-effort */ } }
    }
  }
}
