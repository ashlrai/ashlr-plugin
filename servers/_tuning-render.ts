/**
 * _tuning-render.ts: "self-tuning" section of /ashlr savings.
 *
 * Per repo, per ISO week (UTC, matching the UTC day keys in _stats.byDay):
 *   - saved = this repo's tokens saved (_repo-savings, recorded with the global stats)
 *   - re-read cost = native re-fetch bytes after misses / 4 (estimate, tokens)
 *   - net (est.) = saved - re-read cost
 *   - miss rate = misses / compressed ashlr results
 * Everything here is this repo only; the all-repo totals elsewhere are untouched.
 */

import { isoWeek, readRepoMissFile, trackingDisabledReason } from "./_miss-tracker";
import { readRepoSavings } from "./_repo-savings";

export const BYTES_PER_TOKEN = 4;
export const WEEKS_SHOWN = 4;

export function renderTuningSection(
  homeDir: string,
  cwd: string = process.cwd(),
  now: number = Date.now(),
): string | null {
  const reason = trackingDisabledReason();
  if (reason) return `self-tuning: off (${reason})`;
  const { weeks } = readRepoMissFile(homeDir, cwd);
  const saved = readRepoSavings(homeDir, cwd).weeks;
  const keys: string[] = [];
  for (let i = WEEKS_SHOWN - 1; i >= 0; i--) keys.push(isoWeek(now - i * 7 * 86400000));
  if (!keys.some((k) => weeks[k] || saved[k])) return null;
  const fmt = (n: number) => n.toLocaleString("en-US");
  const row = (a: string, b: string, c: string, d: string, e: string) =>
    `  ${a.padEnd(9)}${b.padStart(12)}${c.padStart(16)}${d.padStart(16)}   ${e}`;
  const lines = ["self-tuning (this repo, UTC weeks)", row("week", "saved tok", "re-read (est.)", "net tok (est.)", "miss rate")];
  for (const k of keys) {
    const w = weeks[k] ?? { compressed: 0, misses: 0, refetchBytes: 0 };
    const s = saved[k] ?? 0;
    const cost = Math.round(w.refetchBytes / BYTES_PER_TOKEN);
    const rate = w.compressed > 0 ? `${((w.misses / w.compressed) * 100).toFixed(1)}% (${w.misses}/${w.compressed})` : "n/a";
    lines.push(row(k, fmt(s), fmt(cost), fmt(s - cost), rate));
  }
  lines.push("  net = this repo's tokens saved minus native re-reads after compact output (bytes/4 estimate)");
  return lines.join("\n");
}
