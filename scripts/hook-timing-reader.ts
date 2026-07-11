import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  type Stats,
} from "fs";
import { homedir } from "os";
import { join } from "path";

export const HOOK_TIMING_CHUNK_BYTES = 64 * 1024;
export const HOOK_TIMING_MAX_ROW_BYTES = 64 * 1024;
export const HOOK_TIMING_SOURCE_MAX_BYTES = 16 * 1024 * 1024;
const METADATA_MAX_BYTES = 16 * 1024;

export interface HookTimingRecord {
  ts: string;
  hook: string;
  tool: string | null;
  durationMs: number;
  outcome: "ok" | "bypass" | "block" | "error" | "timeout";
}

export interface HookTimingSourceQuality {
  path: string;
  source: "retained" | "active";
  exists: boolean;
  bytesRead: number;
  parsedRows: number;
  /** Parsed object rows retained after applying the requested time window. */
  retainedRows: number;
  malformedRows: number;
  oversizedRows: number;
  /** Older source bytes were excluded to enforce the per-source scan ceiling. */
  truncatedPrefix: boolean;
  truncatedTail: boolean;
  unreadable: boolean;
  raced: boolean;
}

export interface HookTimingReadQuality {
  coverage: "complete" | "partial";
  requestedSinceMs: number | null;
  droppedThrough: string | null;
  metadataPresent: boolean;
  metadataUnreadable: boolean;
  metadataMalformed: boolean;
  writerLockObserved: boolean;
  retries: number;
  sources: HookTimingSourceQuality[];
}

export interface HookTimingDetailedRead {
  records: HookTimingRecord[];
  /** Syntactically valid object rows matching the requested window, for weaker schemas. */
  rows: Record<string, unknown>[];
  coverage: "complete" | "partial";
  quality: HookTimingReadQuality;
  /** Convenience alias for consumers that only need per-file evidence. */
  sourceQuality: HookTimingSourceQuality[];
}

export interface HookTimingReadOptions {
  path?: string;
  sinceMs?: number;
  chunkBytes?: number;
  maxRowBytes?: number;
  /** @internal Deterministic seam for snapshot-race tests. */
  _beforeVerify?: (attempt: number) => void;
}

interface FileSnapshot {
  exists: boolean;
  unreadable?: boolean;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
}

interface ScanResult {
  rows: Record<string, unknown>[];
  quality: HookTimingSourceQuality;
}

function snapshot(path: string): FileSnapshot {
  try {
    const stat = statSync(path);
    return {
      exists: true, dev: stat.dev, ino: stat.ino, size: stat.size,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" || code === "EIO"
      ? { exists: true, unreadable: true }
      : { exists: false };
  }
}

function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  return a.exists === b.exists && (!a.exists || (
    a.unreadable === b.unreadable && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
  ));
}

function matchesStat(expected: FileSnapshot, actual: Stats): boolean {
  return expected.exists && expected.dev === actual.dev && expected.ino === actual.ino &&
    expected.size === actual.size && expected.mtimeMs === actual.mtimeMs &&
    expected.ctimeMs === actual.ctimeMs;
}

function scanFile(
  path: string,
  source: HookTimingSourceQuality["source"],
  expected: FileSnapshot,
  chunkBytes: number,
  maxRowBytes: number,
  sinceMs: number | null,
): ScanResult {
  const quality: HookTimingSourceQuality = {
    path, source, exists: expected.exists, bytesRead: 0, parsedRows: 0,
    retainedRows: 0, malformedRows: 0, oversizedRows: 0,
    truncatedPrefix: false, truncatedTail: false,
    unreadable: false, raced: false,
  };
  const rows: Record<string, unknown>[] = [];
  if (!expected.exists) return { rows, quality };
  if (expected.unreadable) {
    quality.unreadable = true;
    return { rows, quality };
  }

  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    if (!matchesStat(expected, fstatSync(fd))) {
      quality.raced = true;
      return { rows, quality };
    }

    const chunk = Buffer.allocUnsafe(chunkBytes);
    let carry = Buffer.alloc(0);
    let discardingOversized = false;
    const sourceSize = expected.size ?? 0;
    let position = Math.max(0, sourceSize - HOOK_TIMING_SOURCE_MAX_BYTES);
    let remaining = sourceSize - position;
    let discardingPrefix = position > 0;
    quality.truncatedPrefix = discardingPrefix;

    const consume = (line: Buffer): void => {
      const normalized = line.length > 0 && line[line.length - 1] === 13
        ? line.subarray(0, line.length - 1)
        : line;
      if (normalized.length === 0) return;
      try {
        const parsed: unknown = JSON.parse(normalized.toString("utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const row = parsed as Record<string, unknown>;
          quality.parsedRows++;
          if (timingRecord(row) === null) quality.malformedRows++;

          const timestamp = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
          if (sinceMs === null || (Number.isFinite(timestamp) && timestamp >= sinceMs)) {
            rows.push(row);
            quality.retainedRows++;
          }
        } else {
          quality.malformedRows++;
        }
      } catch {
        quality.malformedRows++;
      }
    };

    while (remaining > 0) {
      const wanted = Math.min(chunk.length, remaining);
      const read = readSync(fd, chunk, 0, wanted, position);
      if (read <= 0) {
        quality.raced = true;
        break;
      }
      quality.bytesRead += read;
      position += read;
      remaining -= read;
      let offset = 0;
      while (offset < read) {
        const newline = chunk.subarray(0, read).indexOf(10, offset);

        // The bounded window may begin in the middle of a foreign row. Start
        // parsing only after the first complete-line boundary in the window.
        if (discardingPrefix) {
          if (newline === -1) {
            offset = read;
          } else {
            discardingPrefix = false;
            offset = newline + 1;
          }
          continue;
        }
        const end = newline === -1 ? read : newline;
        const piece = chunk.subarray(offset, end);

        if (discardingOversized) {
          if (newline !== -1) discardingOversized = false;
        } else if (carry.length + piece.length > maxRowBytes) {
          quality.oversizedRows++;
          carry = Buffer.alloc(0);
          discardingOversized = newline === -1;
        } else if (newline !== -1) {
          if (carry.length === 0) consume(piece);
          else {
            const line = Buffer.allocUnsafe(carry.length + piece.length);
            carry.copy(line);
            piece.copy(line, carry.length);
            consume(line);
            carry = Buffer.alloc(0);
          }
        } else if (piece.length > 0) {
          const next = Buffer.allocUnsafe(carry.length + piece.length);
          carry.copy(next);
          piece.copy(next, carry.length);
          carry = next;
        }
        offset = newline === -1 ? read : newline + 1;
      }
    }

    // A syntactically complete legacy final row is valid without a newline.
    if (carry.length > 0) {
      const malformedBefore = quality.malformedRows;
      consume(carry);
      if (quality.malformedRows > malformedBefore) quality.truncatedTail = true;
    }
    if (discardingOversized) quality.truncatedTail = true;
  } catch {
    quality.unreadable = true;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
  return { rows, quality };
}

interface MetadataRead {
  present: boolean;
  droppedThrough: string | null;
  unreadable: boolean;
  malformed: boolean;
}

function readMetadata(path: string): MetadataRead {
  const metaPath = `${path}.meta.json`;
  const meta = snapshot(metaPath);
  if (!meta.exists) return { present: false, droppedThrough: null, unreadable: false, malformed: false };
  if (meta.unreadable) return { present: true, droppedThrough: null, unreadable: true, malformed: false };
  if ((meta.size ?? 0) > METADATA_MAX_BYTES) {
    return { present: true, droppedThrough: null, unreadable: false, malformed: true };
  }
  try {
    const value = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || !(value.droppedThrough === null || typeof value.droppedThrough === "string") || typeof value.updatedAt !== "string") {
      return { present: true, droppedThrough: null, unreadable: false, malformed: true };
    }
    if (typeof value.droppedThrough === "string" && !Number.isFinite(Date.parse(value.droppedThrough))) {
      return { present: true, droppedThrough: null, unreadable: false, malformed: true };
    }
    return { present: true, droppedThrough: value.droppedThrough as string | null, unreadable: false, malformed: false };
  } catch (error) {
    return error instanceof SyntaxError
      ? { present: true, droppedThrough: null, unreadable: false, malformed: true }
      : { present: true, droppedThrough: null, unreadable: true, malformed: false };
  }
}

function timingRecord(row: Record<string, unknown>): HookTimingRecord | null {
  // Keep the compatibility reader's historical weak field validation. The
  // declared union guides typed writers, but older/custom string outcomes are
  // still readable at runtime as they were before this scanner existed.
  if (typeof row.ts !== "string" || typeof row.hook !== "string" ||
      typeof row.durationMs !== "number" || typeof row.outcome !== "string") return null;
  return {
    ts: row.ts,
    hook: row.hook,
    tool: typeof row.tool === "string" ? row.tool : null,
    durationMs: row.durationMs,
    outcome: row.outcome as HookTimingRecord["outcome"],
  };
}

/**
 * Read retained then active timing rows using fixed-size chunks. The two-file
 * snapshot is verified before and after scanning and retried once on rotation.
 */
export function readHookTimingsDetailed(
  options: HookTimingReadOptions | string = {},
  requestedSinceMs?: number,
): HookTimingDetailedRead {
  const opts = typeof options === "string"
    ? { path: options, sinceMs: requestedSinceMs }
    : { ...options, sinceMs: options.sinceMs ?? requestedSinceMs };
  const path = opts.path ?? join(homedir(), ".ashlr", "hook-timings.jsonl");
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs! : null;
  const chunkBytes = Math.max(1024, Math.min(opts.chunkBytes ?? HOOK_TIMING_CHUNK_BYTES, 1024 * 1024));
  const maxRowBytes = Math.max(1024, Math.min(opts.maxRowBytes ?? HOOK_TIMING_MAX_ROW_BYTES, 1024 * 1024));
  const sourcePaths = [`${path}.1`, path] as const;
  const metadataPath = `${path}.meta.json`;
  const lockPath = `${path}.lock`;
  let scans: ScanResult[] = [];
  let metadata: MetadataRead = {
    present: false, droppedThrough: null, unreadable: false, malformed: false,
  };
  let retries = 0;
  let stable = false;
  let writerLockObserved = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const lockBefore = snapshot(lockPath);
    const before = [...sourcePaths, metadataPath].map(snapshot);
    writerLockObserved ||= lockBefore.exists;
    scans = [
      scanFile(sourcePaths[0], "retained", before[0]!, chunkBytes, maxRowBytes, sinceMs),
      scanFile(sourcePaths[1], "active", before[1]!, chunkBytes, maxRowBytes, sinceMs),
    ];
    metadata = readMetadata(path);
    opts._beforeVerify?.(attempt);
    const after = [...sourcePaths, metadataPath].map(snapshot);
    const lockAfter = snapshot(lockPath);
    writerLockObserved ||= lockAfter.exists;
    stable = !lockBefore.exists && !lockAfter.exists &&
      before.every((value, index) => sameSnapshot(value, after[index]!)) &&
      scans.every((scan) => !scan.quality.raced);
    if (stable) break;
    if (attempt === 0) retries = 1;
  }
  if (!stable) scans.forEach((scan) => {
    scan.quality.raced = true;
    scan.quality.retainedRows = 0;
    scan.rows = [];
  });

  const rows = scans.flatMap((scan) => scan.rows);
  const records = rows.map(timingRecord).filter((record): record is HookTimingRecord => record !== null);
  const droppedMs = metadata.droppedThrough ? Date.parse(metadata.droppedThrough) : NaN;
  const droppedInWindow = Number.isFinite(droppedMs) && (sinceMs === null || droppedMs >= sinceMs);
  const unknownDroppedHistory = metadata.present && metadata.droppedThrough === null;
  const sourceDamage = scans.some(({ quality }) => quality.unreadable || quality.raced ||
    quality.truncatedPrefix || quality.truncatedTail ||
    quality.oversizedRows > 0 || quality.malformedRows > 0);
  const coverage = droppedInWindow || unknownDroppedHistory || sourceDamage ||
    metadata.unreadable || metadata.malformed
    ? "partial" as const
    : "complete" as const;
  const quality: HookTimingReadQuality = {
    coverage,
    requestedSinceMs: sinceMs,
    droppedThrough: metadata.droppedThrough,
    metadataPresent: metadata.present,
    metadataUnreadable: metadata.unreadable,
    metadataMalformed: metadata.malformed,
    writerLockObserved,
    retries,
    sources: scans.map((scan) => scan.quality),
  };
  return { records, rows, coverage, quality, sourceQuality: quality.sources };
}
