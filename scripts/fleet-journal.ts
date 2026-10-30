/** Shared bounded, link-resistant reads of fleet JSONL journals. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export const JOURNAL_MAX_BYTES = 4 * 1024 * 1024;
/** Only terminal statuses release a request; anything else still awaits review. */
export const TERMINAL_STATUSES = new Set(["applied", "rejected", "withdrawn", "superseded"]);

export interface JournalEntry {
  /** Parsed object record. */
  record: Record<string, unknown>;
  /** 1-based physical line number in the journal. */
  line: number;
}

export interface JournalRead {
  entries: JournalEntry[];
  /** Non-empty lines that were not JSON objects. */
  skipped: number;
}

/** Bounded, link-resistant read of a JSONL journal; a missing journal reads empty. */
export function readJournal(path: string): JournalRead {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], skipped: 0 };
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe fleet journal");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const now = fstatSync(fd);
    if (!now.isFile() || now.nlink !== 1 || now.ino !== stat.ino || now.dev !== stat.dev) throw new Error("unsafe fleet journal");
    if (now.size > JOURNAL_MAX_BYTES) throw new Error("fleet journal too large");
    const buffer = Buffer.alloc(now.size);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    const entries: JournalEntry[] = [];
    let skipped = 0;
    buffer.toString("utf8", 0, length).split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          entries.push({ record: parsed as Record<string, unknown>, line: index + 1 });
        } else skipped++;
      } catch { skipped++; }
    });
    return { entries, skipped };
  } finally { closeSync(fd); }
}
