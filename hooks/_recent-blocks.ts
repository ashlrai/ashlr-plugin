/**
 * _recent-blocks.ts — Lightweight append log for PreToolUse redirect events.
 *
 * When a pretooluse-*.ts hook blocks a native tool call (redirect mode), it
 * appends a small record here so the posttooluse-correlate.ts hook can match
 * a subsequent ashlr__* tool call and emit `tool_called_after_block`.
 *
 * Design constraints:
 *   - Best-effort only. Failure → silent continue. Never block the hook path.
 *   - File: ~/.ashlr/recent-blocks.jsonl. Capped at ≤200 entries.
 *   - recordBlock() is APPEND-ONLY — appendFileSync is POSIX-atomic for
 *     writes smaller than PIPE_BUF (~512B–4KB). Each JSONL line is ≤200B,
 *     well inside the threshold, so concurrent hook subprocesses cannot
 *     interleave bytes. Last-write-wins data loss is eliminated.
 *     Windows note: NT file writes are also atomic for small sequential
 *     writes below the page size (4KB). Our lines are ~200B, so the same
 *     guarantee holds.
 *   - Truncation (MAX_ENTRIES cap) is deferred to readRecentBlocks() — a
 *     lazy pruneOldBlocks() that rewrites via atomic rename when the file
 *     grows past MAX_ENTRIES * 1.5. No write contention on the hot path.
 *   - Synchronous write (hooks are subprocesses; async write + process.exit
 *     races unless we use appendFileSync or drain a promise before exit).
 *   - Kill switch: ASHLR_SESSION_LOG=0 disables all telemetry including this.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export interface RecentBlock {
  ts: number;          // Date.now() — epoch ms for fast comparison
  toolName: string;    // native tool that was blocked, e.g. "Grep"
  pattern?: string;    // grep pattern / file path hint — for correlation
  filePath?: string;   // for Read / Edit blocks
}

const MAX_ENTRIES = 200;

function blocksPath(home: string = process.env.HOME ?? homedir()): string {
  return join(home, ".ashlr", "recent-blocks.jsonl");
}

/**
 * Append one block record. Never throws — all errors are swallowed silently.
 * Must be synchronous so it completes before the hook calls process.exit().
 *
 * Race safety: uses appendFileSync which is atomic for writes < PIPE_BUF
 * (~512B–4KB on POSIX; ~4KB on Windows). Our JSONL lines are ≤200B.
 * Concurrent hook subprocesses can all call this simultaneously without
 * losing records — each append is an independent atomic kernel operation.
 */
export function recordBlock(block: RecentBlock): void {
  if (process.env.ASHLR_SESSION_LOG === "0") return;
  try {
    const path = blocksPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(block) + "\n", "utf-8");
  } catch {
    // Silently swallow — telemetry must never break hook critical path.
  }
}

/**
 * Read the recent blocks log, skip malformed lines, and lazily prune if the
 * file has grown past MAX_ENTRIES * 1.5. Returns an empty array on any error.
 * Used by posttooluse-correlate.ts to find matches.
 *
 * Pruning uses an atomic rename (write → .tmp, rename) so concurrent readers
 * never observe a partial file.
 */
export function readRecentBlocks(home: string = process.env.HOME ?? homedir()): RecentBlock[] {
  try {
    const path = blocksPath(home);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
    const records: RecentBlock[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as RecentBlock);
      } catch {
        // Skip malformed lines — guards against partial writes during crashes.
      }
    }
    // Lazy prune: rewrite via atomic rename when file exceeds 1.5× cap.
    if (records.length > MAX_ENTRIES * 1.5) {
      const pruned = records.slice(-MAX_ENTRIES);
      _atomicRewrite(path, pruned);
      return pruned;
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Remove block records older than `windowMs` ms from the file.
 * Called by posttooluse-correlate.ts after matching so the file stays trim.
 * Best-effort — never throws.
 */
export function pruneOldBlocks(windowMs: number, home: string = process.env.HOME ?? homedir()): void {
  try {
    const path = blocksPath(home);
    if (!existsSync(path)) return;
    const cutoff = Date.now() - windowMs;
    const records = readRecentBlocks(home).filter((r) => r.ts >= cutoff);
    _atomicRewrite(path, records);
  } catch {
    // Best-effort.
  }
}

/**
 * Write `records` to `path` atomically by writing to a `.tmp` sibling first,
 * then renaming. Rename is atomic on POSIX and atomic on NTFS (same volume).
 */
function _atomicRewrite(path: string, records: RecentBlock[]): void {
  const tmp = path + ".tmp";
  const content = records.length === 0
    ? ""
    : records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}
