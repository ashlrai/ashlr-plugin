/** Shared bounded, link-resistant reads of fleet JSONL journals. */
import { lstatSync } from "node:fs";
import { FLEET_MAX_BYTES, readBoundedFile } from "./lib/fleet-common.ts";

export const JOURNAL_MAX_BYTES = FLEET_MAX_BYTES;
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
  let text: string;
  try {
    text = readBoundedFile(path, stat, JOURNAL_MAX_BYTES).toString("utf8");
  } catch (error) {
    throw new Error(error instanceof Error && error.message === "too_large" ? "fleet journal too large" : "unsafe fleet journal");
  }
  const entries: JournalEntry[] = [];
  let skipped = 0;
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push({ record: parsed as Record<string, unknown>, line: index + 1 });
      } else skipped++;
    } catch { skipped++; }
  });
  return { entries, skipped };
}
