/**
 * _edit-log — shared edit session log used by edit-server + flush-server.
 *
 * All edits write immediately to disk; this log is a "what did I just write?"
 * reporting aid — ashlr__flush drains it to return a compact batch summary.
 *
 * Module-level singleton (process-wide). Lives for a single MCP server session.
 */

export interface EditLogEntry {
  relPath: string;
  hunksApplied: number;
}

const editLog: EditLogEntry[] = [];

/** Append one edit record to the log. */
export function appendEdit(entry: EditLogEntry): void {
  editLog.push(entry);
}

/**
 * Drain and return all pending edits. The log is empty after this call.
 * Returns an empty array if nothing was logged since the last drain.
 */
export function drainEdits(): EditLogEntry[] {
  return editLog.splice(0, editLog.length);
}
