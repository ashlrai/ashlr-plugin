import { randomUUID } from "crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";

export const HOOK_TIMING_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const HOOK_TIMING_BATCH_MAX_BYTES = 256 * 1024;

const LOCK_STALE_MS = 30_000;
const LOCK_HARD_STALE_MS = 5 * 60_000;
const LOCK_FUTURE_SKEW_MS = 5_000;
const LOCK_WAIT_MS = 500;
const LOCK_POLL_MS = 5;

interface LockOwner {
  token: string;
  pid: number;
  createdAt: string;
}

interface DropMetadata {
  schemaVersion: 1;
  droppedThrough: string | null;
  updatedAt: string;
}

export type HookTimingWriteResult = "written" | "contended" | "failed";

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function hardenDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    /* Some platforms/filesystems do not support directory fsync. */
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function atomicReplace(path: string, write: (fd: number) => void): void {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    write(fd);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* fail open */ }
    }
    try { rmSync(tempPath, { force: true }); } catch { /* fail open */ }
  }
}

function atomicWrite(path: string, data: string | Buffer | readonly Buffer[]): void {
  atomicReplace(path, (fd) => {
    if (typeof data !== "string" && !Buffer.isBuffer(data)) {
      for (const chunk of data) writeFileSync(fd, chunk);
    } else {
      writeFileSync(fd, data);
    }
  });
}

function atomicCopyRange(path: string, sourceFd: number, start: number, end: number): void {
  atomicReplace(path, (targetFd) => {
    const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let position = start;
    while (position < end) {
      const count = readSync(
        sourceFd,
        chunk,
        0,
        Math.min(chunk.length, end - position),
        position,
      );
      if (count === 0) throw new Error("Unexpected EOF while copying timing ledger");
      writeFileSync(targetFd, chunk.subarray(0, count));
      position += count;
    }
  });
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    if (
      typeof value?.token !== "string" ||
      !Number.isSafeInteger(value?.pid) ||
      typeof value?.createdAt !== "string"
    ) return null;
    return value as LockOwner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface LockIdentity {
  lockDev: number;
  lockIno: number;
  lockCtimeMs: number;
  ownerToken: string | null;
  ownerDev: number | null;
  ownerIno: number | null;
  ownerCtimeMs: number | null;
}

let testBeforeStaleQuarantine: ((lockPath: string) => void) | null = null;
let testAfterReaperPrecheck: ((lockPath: string) => void) | null = null;

/** @internal Test seam for deterministic stale-lock replacement races. */
export function __setBeforeStaleQuarantineForTest(
  callback: ((lockPath: string) => void) | null,
): void {
  testBeforeStaleQuarantine = callback;
}

/** @internal Test seam for a writer paused between guard check and lock create. */
export function __setAfterReaperPrecheckForTest(
  callback: ((lockPath: string) => void) | null,
): void {
  testAfterReaperPrecheck = callback;
}

function readLockIdentity(lockPath: string): { identity: LockIdentity; owner: LockOwner | null; mtimeMs: number } | null {
  try {
    const lockBefore = statSync(lockPath);
    let ownerStat: ReturnType<typeof statSync> | null = null;
    try { ownerStat = statSync(join(lockPath, "owner.json")); } catch { /* invalid owner */ }
    const owner = readOwner(lockPath);
    const lockAfter = statSync(lockPath);
    if (lockBefore.dev !== lockAfter.dev || lockBefore.ino !== lockAfter.ino) return null;
    return {
      identity: {
        lockDev: lockAfter.dev,
        lockIno: lockAfter.ino,
        lockCtimeMs: lockAfter.ctimeMs,
        ownerToken: owner?.token ?? null,
        ownerDev: ownerStat?.dev ?? null,
        ownerIno: ownerStat?.ino ?? null,
        ownerCtimeMs: ownerStat?.ctimeMs ?? null,
      },
      owner,
      mtimeMs: lockAfter.mtimeMs,
    };
  } catch {
    return null;
  }
}

function sameLockIdentity(actual: LockIdentity, expected: LockIdentity): boolean {
  return actual.lockDev === expected.lockDev &&
    actual.lockIno === expected.lockIno &&
    actual.ownerToken === expected.ownerToken &&
    actual.ownerDev === expected.ownerDev &&
    actual.ownerIno === expected.ownerIno &&
    actual.ownerCtimeMs === expected.ownerCtimeMs;
}

function inspectStaleLock(lockPath: string): LockIdentity | null {
  try {
    const inspected = readLockIdentity(lockPath);
    if (!inspected) return null;
    const { identity, owner, mtimeMs } = inspected;
    const parsedCreated = owner ? Date.parse(owner.createdAt) : Number.NaN;
    const now = Date.now();
    const created = Number.isFinite(parsedCreated) && parsedCreated <= now + LOCK_FUTURE_SKEW_MS
      ? parsedCreated
      : mtimeMs;
    const age = Math.max(0, now - Math.min(created, mtimeMs));
    if (age > LOCK_HARD_STALE_MS) return identity;
    if (age <= LOCK_STALE_MS) return null;
    return owner === null || !processIsAlive(owner.pid) ? identity : null;
  } catch {
    return null;
  }
}

function quarantineStaleLock(lockPath: string, expected: LockIdentity): boolean {
  const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, quarantine);
  } catch {
    return false;
  }
  const renamed = readLockIdentity(quarantine);
  if (!renamed || !sameLockIdentity(renamed.identity, expected)) {
    try {
      if (!existsSync(lockPath)) renameSync(quarantine, lockPath);
    } catch {
      /* Never delete an identity-mismatched lock. */
    }
    fsyncDirectory(dirname(lockPath));
    return false;
  }
  try { chmodSync(quarantine, 0o700); } catch { /* best effort */ }
  try { rmSync(quarantine, { recursive: true, force: true }); } catch { /* fail open */ }
  fsyncDirectory(dirname(lockPath));
  return true;
}

function createLockOwner(): LockOwner {
  return {
    token: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
}

function tryAcquireReaperGuard(lockPath: string): { path: string; owner: LockOwner } | null {
  const owner = createLockOwner();
  const path = `${lockPath}.reap-${owner.token}`;
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
    chmodSync(path, 0o700);
    atomicWrite(join(path, "owner.json"), JSON.stringify(owner) + "\n");
    return { path, owner };
  } catch {
    if (created) {
      try { rmSync(path, { recursive: true, force: true }); } catch { /* fail open */ }
    }
    return null;
  }
}

function listReaperGuards(lockPath: string): string[] {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.reap-`;
  try {
    return readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

function hasActiveReaperGuard(lockPath: string): boolean {
  for (const path of listReaperGuards(lockPath)) {
    const stale = inspectStaleLock(path);
    if (stale) quarantineStaleLock(path, stale);
  }
  return listReaperGuards(lockPath).length > 0;
}

function releaseOwnedDirectory(path: string, owner: LockOwner): void {
  try {
    if (readOwner(path)?.token !== owner.token) return;
    rmSync(path, { recursive: true, force: true });
    fsyncDirectory(dirname(path));
  } catch {
    /* telemetry is fail open */
  }
}

function reapStaleLock(lockPath: string, expected: LockIdentity): boolean {
  const guard = tryAcquireReaperGuard(lockPath);
  if (!guard) return false;
  try {
    testBeforeStaleQuarantine?.(lockPath);
    const current = inspectStaleLock(lockPath);
    if (!current || !sameLockIdentity(current, expected)) return false;
    return quarantineStaleLock(lockPath, expected);
  } finally {
    releaseOwnedDirectory(guard.path, guard.owner);
  }
}

function acquireLock(
  lockPath: string,
  waitMs: number,
): { owner: LockOwner | null; result: HookTimingWriteResult } {
  const deadline = Date.now() + waitMs;
  let firstAttempt = true;
  while (firstAttempt || Date.now() <= deadline) {
    firstAttempt = false;
    if (hasActiveReaperGuard(lockPath)) {
      if (Date.now() < deadline) sleepSync(Math.min(LOCK_POLL_MS, deadline - Date.now()));
      continue;
    }
    testAfterReaperPrecheck?.(lockPath);
    const owner = createLockOwner();
    let created = false;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      created = true;
      chmodSync(lockPath, 0o700);
      atomicWrite(join(lockPath, "owner.json"), JSON.stringify(owner) + "\n");
      // A reaper may have appeared after the precheck. Relinquish this lock
      // before entering the ledger transaction so quarantine remains exclusive.
      if (hasActiveReaperGuard(lockPath)) {
        releaseOwnedDirectory(lockPath, owner);
        if (Date.now() < deadline) sleepSync(Math.min(LOCK_POLL_MS, deadline - Date.now()));
        continue;
      }
      return { owner, result: "written" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (created) {
          try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* fail open */ }
        }
        return { owner: null, result: "failed" };
      }
      const staleIdentity = inspectStaleLock(lockPath);
      if (staleIdentity) {
        reapStaleLock(lockPath, staleIdentity);
      }
      else if (Date.now() < deadline) sleepSync(Math.min(LOCK_POLL_MS, deadline - Date.now()));
    }
  }
  return { owner: null, result: "contended" };
}

function releaseLock(lockPath: string, owner: LockOwner): void {
  try {
    if (readOwner(lockPath)?.token !== owner.token) return;
    rmSync(lockPath, { recursive: true, force: true });
    fsyncDirectory(dirname(lockPath));
  } catch {
    /* telemetry is fail open */
  }
}

const SCAN_CHUNK_BYTES = 64 * 1024;
const OVERSIZED_LINE_PREFIX_BYTES = 64 * 1024;

interface RowEntry {
  data: Buffer;
  ts: string | null;
}

interface RowWindow {
  entries: RowEntry[];
  head: number;
  bytes: number;
  limit: number;
  droppedThrough: string | null;
  hadDropped: boolean;
}

function advanceTimestamp(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  const candidateTime = Date.parse(candidate);
  if (!Number.isFinite(candidateTime)) return current;
  if (!current) return candidate;
  const currentTime = Date.parse(current);
  return !Number.isFinite(currentTime) || candidateTime > currentTime ? candidate : current;
}

function timestampFromRecord(record: Record<string, unknown>): string | null {
  return typeof record.ts === "string" && Number.isFinite(Date.parse(record.ts))
    ? record.ts
    : null;
}

function timestampFromOversizedPrefix(prefix: Buffer): string | null {
  const match = prefix.toString("utf8").match(/"ts"\s*:\s*("(?:\\.|[^"\\])*")/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]!) as unknown;
    return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

function createWindow(limit: number): RowWindow {
  return {
    entries: [],
    head: 0,
    bytes: 0,
    limit,
    droppedThrough: null,
    hadDropped: false,
  };
}

function noteDropped(window: RowWindow, ts: string | null): void {
  window.hadDropped = true;
  window.droppedThrough = advanceTimestamp(window.droppedThrough, ts);
}

function compactWindow(window: RowWindow): void {
  if (window.head < 4096 || window.head * 2 < window.entries.length) return;
  window.entries = window.entries.slice(window.head);
  window.head = 0;
}

function pushValidRow(window: RowWindow, entry: RowEntry): void {
  if (window.limit === 0 || entry.data.length > Math.min(window.limit, HOOK_TIMING_FILE_MAX_BYTES)) {
    noteDropped(window, entry.ts);
    return;
  }
  window.entries.push(entry);
  window.bytes += entry.data.length;
  while (window.bytes > window.limit && window.head < window.entries.length) {
    const droppedIndex = window.head++;
    const dropped = window.entries[droppedIndex]!;
    window.entries[droppedIndex] = { data: Buffer.alloc(0), ts: null };
    window.bytes -= dropped.data.length;
    noteDropped(window, dropped.ts);
  }
  compactWindow(window);
}

function consumeCompleteLine(window: RowWindow, line: Buffer): void {
  try {
    const parsed = JSON.parse(line.subarray(0, -1).toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      noteDropped(window, null);
      return;
    }
    pushValidRow(window, {
      data: line,
      ts: timestampFromRecord(parsed as Record<string, unknown>),
    });
  } catch {
    noteDropped(window, null);
  }
}

function appendPrefix(prefix: Buffer, source: Buffer): Buffer {
  const remaining = OVERSIZED_LINE_PREFIX_BYTES - prefix.length;
  if (remaining <= 0) return prefix;
  return Buffer.concat([prefix, source.subarray(0, remaining)]);
}

function findNewline(buffer: Buffer, start: number, end: number): number {
  const relative = buffer.subarray(start, end).indexOf(0x0a);
  return relative < 0 ? -1 : start + relative;
}

/** Stream complete JSONL rows, retaining only the newest `limit` bytes. */
function scanJsonlFile(path: string, limit: number): RowWindow {
  const window = createWindow(limit);
  let fd: number | null = null;
  let pending: Buffer = Buffer.alloc(0);
  let discardingOversized = false;
  let oversizedPrefix: Buffer = Buffer.alloc(0);
  try {
    fd = openSync(path, constants.O_RDONLY);
    const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (count === 0) break;
      position += count;
      let offset = 0;
      while (offset < count) {
        if (discardingOversized) {
          const newline = findNewline(chunk, offset, count);
          const end = newline < 0 ? count : newline + 1;
          oversizedPrefix = appendPrefix(oversizedPrefix, chunk.subarray(offset, end));
          if (newline < 0) break;
          noteDropped(window, timestampFromOversizedPrefix(oversizedPrefix));
          oversizedPrefix = Buffer.alloc(0);
          discardingOversized = false;
          offset = newline + 1;
          continue;
        }

        const newline = findNewline(chunk, offset, count);
        if (newline < 0) {
          const remainder = chunk.subarray(offset, count);
          if (pending.length + remainder.length > HOOK_TIMING_FILE_MAX_BYTES) {
            oversizedPrefix = appendPrefix(oversizedPrefix, pending);
            oversizedPrefix = appendPrefix(oversizedPrefix, remainder);
            pending = Buffer.alloc(0);
            discardingOversized = true;
          } else {
            pending = Buffer.concat([pending, remainder]);
          }
          break;
        }

        const fragment = chunk.subarray(offset, newline + 1);
        if (pending.length + fragment.length > HOOK_TIMING_FILE_MAX_BYTES) {
          oversizedPrefix = appendPrefix(oversizedPrefix, pending);
          oversizedPrefix = appendPrefix(oversizedPrefix, fragment);
          noteDropped(window, timestampFromOversizedPrefix(oversizedPrefix));
          oversizedPrefix = Buffer.alloc(0);
          pending = Buffer.alloc(0);
        } else {
          const line = pending.length === 0
            ? Buffer.from(fragment)
            : Buffer.concat([pending, fragment]);
          pending = Buffer.alloc(0);
          consumeCompleteLine(window, line);
        }
        offset = newline + 1;
      }
    }
    if (pending.length > 0) {
      try {
        const parsed = JSON.parse(pending.toString("utf8")) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          pushValidRow(window, {
            data: Buffer.concat([pending, Buffer.from("\n")]),
            ts: timestampFromRecord(parsed as Record<string, unknown>),
          });
        } else {
          noteDropped(window, null);
        }
      } catch {
        noteDropped(window, null);
      }
    } else if (discardingOversized) {
      noteDropped(window, null);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") noteDropped(window, null);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* fail open */ }
    }
  }
  compactWindow(window);
  return window;
}

interface ScratchEvidence {
  validBytes: number;
  validatedRows: number;
  hadDropped: boolean;
  droppedThrough: string | null;
}

function noteScratchDrop(evidence: ScratchEvidence, ts: string | null): void {
  evidence.hadDropped = true;
  evidence.droppedThrough = advanceTimestamp(evidence.droppedThrough, ts);
}

function writeScratchLine(
  scratchFd: number,
  evidence: ScratchEvidence,
  line: Buffer,
  hasNewline: boolean,
): void {
  try {
    const json = hasNewline ? line.subarray(0, -1) : line;
    const parsed = JSON.parse(json.toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      noteScratchDrop(evidence, null);
      return;
    }
    writeFileSync(scratchFd, line);
    evidence.validBytes += line.length;
    evidence.validatedRows++;
    if (!hasNewline) {
      writeFileSync(scratchFd, "\n");
      evidence.validBytes += 1;
    }
    // JSON.parse creates one short-lived object per legacy row. Force periodic
    // collection so small-row ledgers stay bounded under Linux/JSC as well as
    // macOS; this path runs only during one-time oversized migration.
    if (evidence.validatedRows % 16_384 === 0) Bun.gc(true);
  } catch {
    noteScratchDrop(evidence, null);
  }
}

/** Validate a legacy ledger into a disk-backed, complete-JSONL scratch file. */
function streamJsonlToScratch(path: string, scratchFd: number): ScratchEvidence {
  const evidence: ScratchEvidence = {
    validBytes: 0,
    validatedRows: 0,
    hadDropped: false,
    droppedThrough: null,
  };
  let sourceFd: number | null = null;
  let pending: Buffer = Buffer.alloc(0);
  let discardingOversized = false;
  let oversizedPrefix: Buffer = Buffer.alloc(0);
  try {
    sourceFd = openSync(path, constants.O_RDONLY);
    const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const count = readSync(sourceFd, chunk, 0, chunk.length, position);
      if (count === 0) break;
      position += count;
      let offset = 0;
      while (offset < count) {
        if (discardingOversized) {
          const newline = findNewline(chunk, offset, count);
          const end = newline < 0 ? count : newline + 1;
          oversizedPrefix = appendPrefix(oversizedPrefix, chunk.subarray(offset, end));
          if (newline < 0) break;
          noteScratchDrop(evidence, timestampFromOversizedPrefix(oversizedPrefix));
          oversizedPrefix = Buffer.alloc(0);
          discardingOversized = false;
          offset = newline + 1;
          continue;
        }

        const newline = findNewline(chunk, offset, count);
        if (newline < 0) {
          const remainder = chunk.subarray(offset, count);
          if (pending.length + remainder.length > HOOK_TIMING_FILE_MAX_BYTES) {
            oversizedPrefix = appendPrefix(oversizedPrefix, pending);
            oversizedPrefix = appendPrefix(oversizedPrefix, remainder);
            pending = Buffer.alloc(0);
            discardingOversized = true;
          } else {
            pending = Buffer.concat([pending, remainder]);
          }
          break;
        }

        const fragment = chunk.subarray(offset, newline + 1);
        if (pending.length + fragment.length > HOOK_TIMING_FILE_MAX_BYTES) {
          oversizedPrefix = appendPrefix(oversizedPrefix, pending);
          oversizedPrefix = appendPrefix(oversizedPrefix, fragment);
          noteScratchDrop(evidence, timestampFromOversizedPrefix(oversizedPrefix));
          oversizedPrefix = Buffer.alloc(0);
          pending = Buffer.alloc(0);
        } else if (pending.length === 0) {
          writeScratchLine(scratchFd, evidence, fragment, true);
        } else {
          const line = Buffer.concat([pending, fragment]);
          pending = Buffer.alloc(0);
          writeScratchLine(scratchFd, evidence, line, true);
        }
        offset = newline + 1;
      }
    }

    if (pending.length > 0) writeScratchLine(scratchFd, evidence, pending, false);
    else if (discardingOversized) noteScratchDrop(evidence, null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") noteScratchDrop(evidence, null);
  } finally {
    if (sourceFd !== null) {
      try { closeSync(sourceFd); } catch { /* fail open */ }
    }
  }
  return evidence;
}

function findTailStart(fd: number, end: number, maxBytes: number): number {
  if (end <= maxBytes) return 0;
  const target = end - maxBytes;
  const previous = Buffer.allocUnsafe(1);
  if (readSync(fd, previous, 0, 1, target - 1) === 1 && previous[0] === 0x0a) {
    return target;
  }
  const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let position = target;
  while (position < end) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, end - position), position);
    if (count === 0) break;
    const newline = findNewline(chunk, 0, count);
    if (newline >= 0) return position + newline + 1;
    position += count;
  }
  return end;
}

function newestTimestampInRange(fd: number, start: number, end: number): string | null {
  let newest: string | null = null;
  let pending: Buffer = Buffer.alloc(0);
  const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let position = start;
  while (position < end) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, end - position), position);
    if (count === 0) break;
    position += count;
    let offset = 0;
    while (offset < count) {
      const newline = findNewline(chunk, offset, count);
      if (newline < 0) {
        pending = Buffer.concat([pending, chunk.subarray(offset, count)]);
        break;
      }
      const fragment = chunk.subarray(offset, newline + 1);
      const line = pending.length === 0 ? fragment : Buffer.concat([pending, fragment]);
      pending = Buffer.alloc(0);
      try {
        const parsed = JSON.parse(line.subarray(0, -1).toString("utf8")) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          newest = advanceTimestamp(newest, timestampFromRecord(parsed as Record<string, unknown>));
        }
      } catch {
        /* Scratch rows were validated; an unexpected parse failure has no timestamp. */
      }
      offset = newline + 1;
    }
  }
  return newest;
}

function cleanupMigrationScratch(path: string): void {
  const directory = dirname(path);
  const prefix = `.${basename(path)}.migrate-`;
  try {
    for (const name of readdirSync(directory)) {
      if (name.startsWith(prefix) && name.endsWith(".tmp")) {
        try { rmSync(join(directory, name), { force: true }); } catch { /* fail open */ }
      }
    }
    fsyncDirectory(directory);
  } catch {
    /* fail open */
  }
}

function parseBatch(input: Buffer): RowEntry[] | null {
  const entries: RowEntry[] = [];
  let offset = 0;
  while (offset < input.length) {
    const newline = input.indexOf(0x0a, offset);
    if (newline < 0) return null;
    const line = input.subarray(offset, newline + 1);
    try {
      const parsed = JSON.parse(line.subarray(0, -1).toString("utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      entries.push({
        data: line,
        ts: timestampFromRecord(parsed as Record<string, unknown>),
      });
    } catch {
      return null;
    }
    offset = newline + 1;
  }
  return entries;
}

function currentEntries(window: RowWindow): RowEntry[] {
  return window.entries.slice(window.head);
}

function timestampOfEntries(entries: readonly RowEntry[], initial: string | null = null): string | null {
  let newest = initial;
  for (const entry of entries) newest = advanceTimestamp(newest, entry.ts);
  return newest;
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function hardenFileIfPresent(path: string): void {
  if (existsSync(path)) chmodSync(path, 0o600);
}

function endsWithNewline(path: string, size: number): boolean {
  if (size === 0) return true;
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    const byte = Buffer.allocUnsafe(1);
    return readSync(fd, byte, 0, 1, size - 1) === 1 && byte[0] === 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* fail open */ }
    }
  }
}

function readDroppedThrough(metaPath: string): string | null {
  try {
    const value = JSON.parse(readFileSync(metaPath, "utf8"));
    return value?.schemaVersion === 1 && typeof value?.droppedThrough === "string"
      ? value.droppedThrough
      : null;
  } catch {
    return null;
  }
}

function writeDropMetadata(metaPath: string, droppedThrough: string | null): void {
  const updatedAt = new Date().toISOString();
  const metadata: DropMetadata = {
    schemaVersion: 1,
    droppedThrough: advanceTimestamp(readDroppedThrough(metaPath), droppedThrough),
    updatedAt,
  };
  atomicWrite(metaPath, JSON.stringify(metadata) + "\n");
}

function appendSecure(path: string, batch: Buffer): void {
  const existed = existsSync(path);
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(fd, batch);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  if (!existed) fsyncDirectory(dirname(path));
}

/**
 * Append one bounded complete-JSONL batch under a portable cross-process lock.
 * The whole size-check/migration/rotation/append sequence is one transaction.
 * Every failure is swallowed so hook telemetry can never break a tool call.
 */
export function appendHookTimingBatch(
  path: string,
  batchText: string,
  options: { lockWaitMs?: number } = {},
): HookTimingWriteResult {
  try {
    const batch = Buffer.from(batchText, "utf8");
    const batchEntries = parseBatch(batch);
    if (
      batch.length === 0 ||
      batch.length > HOOK_TIMING_BATCH_MAX_BYTES ||
      batch[batch.length - 1] !== 0x0a ||
      batchEntries === null
    ) return "failed";

    const directory = dirname(path);
    hardenDirectory(directory);
    const lockPath = `${path}.lock`;
    const lock = acquireLock(lockPath, options.lockWaitMs ?? LOCK_WAIT_MS);
    if (!lock.owner) return lock.result;
    const owner = lock.owner;

    try {
      const retainedPath = `${path}.1`;
      const metaPath = `${path}.meta.json`;
      const activeSize = fileSize(path);
      const retainedSize = fileSize(retainedPath);
      hardenFileIfPresent(path);
      hardenFileIfPresent(retainedPath);
      hardenFileIfPresent(metaPath);
      cleanupMigrationScratch(path);

      // Normal appends avoid reading or parsing the existing ledger. Files
      // produced here are already valid JSONL; the final-byte check detects
      // interrupted/foreign writes and sends only those through recovery.
      if (
        activeSize <= HOOK_TIMING_FILE_MAX_BYTES &&
        activeSize + batch.length <= HOOK_TIMING_FILE_MAX_BYTES &&
        endsWithNewline(path, activeSize) &&
        retainedSize <= HOOK_TIMING_FILE_MAX_BYTES &&
        endsWithNewline(retainedPath, retainedSize)
      ) {
        appendSecure(path, batch);
        return "written";
      }

      if (activeSize > HOOK_TIMING_FILE_MAX_BYTES) {
        const scratchPath = join(
          dirname(path),
          `.${basename(path)}.migrate-${process.pid}-${randomUUID()}.tmp`,
        );
        let scratchFd: number | null = null;
        try {
          scratchFd = openSync(
            scratchPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
            0o600,
          );
          chmodSync(scratchPath, 0o600);
          const evidence = streamJsonlToScratch(path, scratchFd);
          for (const entry of batchEntries) {
            writeFileSync(scratchFd, entry.data);
            evidence.validBytes += entry.data.length;
          }
          fsyncSync(scratchFd);

          const activeStart = findTailStart(
            scratchFd,
            evidence.validBytes,
            HOOK_TIMING_FILE_MAX_BYTES,
          );
          const retainedStart = findTailStart(
            scratchFd,
            activeStart,
            HOOK_TIMING_FILE_MAX_BYTES,
          );
          let droppedThrough = evidence.droppedThrough;
          if (retainedStart > 0) {
            droppedThrough = advanceTimestamp(
              droppedThrough,
              newestTimestampInRange(scratchFd, 0, retainedStart),
            );
          }
          const retainedHistory = scanJsonlFile(retainedPath, 0);
          droppedThrough = advanceTimestamp(droppedThrough, retainedHistory.droppedThrough);
          const metadataNeeded =
            retainedSize > 0 ||
            retainedStart > 0 ||
            evidence.hadDropped ||
            retainedHistory.hadDropped;
          if (metadataNeeded) writeDropMetadata(metaPath, droppedThrough);
          atomicCopyRange(retainedPath, scratchFd, retainedStart, activeStart);
          atomicCopyRange(path, scratchFd, activeStart, evidence.validBytes);
          return "written";
        } finally {
          if (scratchFd !== null) {
            try { closeSync(scratchFd); } catch { /* fail open */ }
          }
          try { rmSync(scratchPath, { force: true }); } catch { /* fail open */ }
          fsyncDirectory(dirname(path));
        }
      }

      const active = scanJsonlFile(path, HOOK_TIMING_FILE_MAX_BYTES);
      const retained = scanJsonlFile(retainedPath, HOOK_TIMING_FILE_MAX_BYTES);

      if (active.bytes + batch.length > HOOK_TIMING_FILE_MAX_BYTES) {
        if (retainedSize > 0 || active.hadDropped) {
          writeDropMetadata(
            metaPath,
            advanceTimestamp(
              timestampOfEntries(currentEntries(retained), retained.droppedThrough),
              active.droppedThrough,
            ),
          );
        }
        atomicWrite(retainedPath, currentEntries(active).map((entry) => entry.data));
        atomicWrite(path, batch);
        return "written";
      }

      if (retained.hadDropped || active.hadDropped) {
        writeDropMetadata(
          metaPath,
          advanceTimestamp(retained.droppedThrough, active.droppedThrough),
        );
      }
      if (retainedSize > HOOK_TIMING_FILE_MAX_BYTES || retained.hadDropped) {
        atomicWrite(retainedPath, currentEntries(retained).map((entry) => entry.data));
      }

      if (active.hadDropped || activeSize !== active.bytes) {
        atomicWrite(path, currentEntries(active).map((entry) => entry.data));
      } else if (existsSync(path)) {
        chmodSync(path, 0o600);
      }
      appendSecure(path, batch);
      return "written";
    } finally {
      releaseLock(lockPath, owner);
    }
  } catch {
    /* telemetry is fail open */
    return "failed";
  }
}

interface TimingWorkerRequest {
  entries: Array<{ path: string; batches: string[] }>;
}

interface TimingWorkerResponse {
  contended: Array<{ path: string; batch: string }>;
}

if (!Bun.isMainThread) {
  globalThis.onmessage = (event: MessageEvent<TimingWorkerRequest>) => {
    const contended: TimingWorkerResponse["contended"] = [];
    for (const { path, batches } of event.data.entries) {
      for (const batch of batches) {
        if (appendHookTimingBatch(path, batch) === "contended") {
          contended.push({ path, batch });
        }
      }
    }
    globalThis.postMessage({ contended } satisfies TimingWorkerResponse);
  };
}
