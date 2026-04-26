/**
 * _recent-blocks.ts — Lightweight append log for PreToolUse redirect events.
 *
 * When a pretooluse-*.ts hook blocks a native tool call (redirect mode), it
 * appends a small record here so the posttooluse-correlate.ts hook can match
 * a subsequent ashlr__* tool call and emit `tool_called_after_block`.
 *
 * Design constraints:
 *   - Best-effort only. Failure → silent continue. Never block the hook path.
 *   - File: ~/.ashlr/recent-blocks.jsonl. Capped at ≤200 entries via
 *     tail-truncation: each write reads, prepends, and slices to MAX_ENTRIES.
 *   - Synchronous write (hooks are subprocesses; async write + process.exit
 *     races unless we use appendFileSync or drain a promise before exit).
 *   - Kill switch: ASHLR_SESSION_LOG=0 disables all telemetry including this.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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
 */
export function recordBlock(block: RecentBlock): void {
  if (process.env.ASHLR_SESSION_LOG === "0") return;
  try {
    const path = blocksPath();
    mkdirSync(dirname(path), { recursive: true });

    // Read existing records (may not exist yet).
    let existing: RecentBlock[] = [];
    if (existsSync(path)) {
      try {
        existing = readFileSync(path, "utf-8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as RecentBlock);
      } catch {
        existing = [];
      }
    }

    // Append new record and cap.
    existing.push(block);
    if (existing.length > MAX_ENTRIES) {
      existing = existing.slice(-MAX_ENTRIES);
    }

    writeFileSync(path, existing.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  } catch {
    // Silently swallow — telemetry must never break hook critical path.
  }
}

/**
 * Read the recent blocks log. Returns an empty array on any error.
 * Used by posttooluse-correlate.ts to find matches.
 */
export function readRecentBlocks(home: string = process.env.HOME ?? homedir()): RecentBlock[] {
  try {
    const path = blocksPath(home);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as RecentBlock);
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
    if (records.length === 0) {
      writeFileSync(path, "", "utf-8");
    } else {
      writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
    }
  } catch {
    // Best-effort.
  }
}
