/**
 * flush-server — ashlr__flush tool implementation.
 *
 * Pure reporting tool: drains the edit log and returns a compact summary of
 * edits applied since the last flush (or session start).
 */

import { drainEdits } from "./_edit-log";

/** Summarize edits applied since the last flush (or session start). */
export async function flushPending(): Promise<string> {
  const batch = drainEdits();
  if (batch.length === 0) return "";
  const lines = [`[ashlr__flush] ${batch.length} edit(s) applied this batch:`];
  for (const e of batch) {
    lines.push(`  ok  ${e.relPath} (${e.hunksApplied} hunk${e.hunksApplied === 1 ? "" : "s"})`);
  }
  return lines.join("\n");
}
