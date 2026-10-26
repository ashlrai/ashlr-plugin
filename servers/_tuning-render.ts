/**
 * _tuning-render.ts: "self-tuning" section of /ashlr savings.
 *
 * Per repo, per ISO week (UTC, matching the UTC day keys in _stats.byDay):
 *   - miss rate = misses / compressed ashlr results
 *   - re-read cost = native re-fetch bytes after misses / 4 (estimate, tokens)
 * Savings totals elsewhere in the report are all-repo figures; this section
 * deliberately does not subtract one repo's re-reads from them.
 */

import { isoWeek, readRepoMissFile, trackingDisabledReason } from "./_miss-tracker";

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
  const keys: string[] = [];
  for (let i = WEEKS_SHOWN - 1; i >= 0; i--) keys.push(isoWeek(now - i * 7 * 86400000));
  if (!keys.some((k) => weeks[k])) return null;
  const lines = ["self-tuning (this repo, UTC weeks)   miss rate        re-read cost (est.)"];
  for (const k of keys) {
    const w = weeks[k] ?? { compressed: 0, misses: 0, refetchBytes: 0 };
    const rate = w.compressed > 0 ? `${((w.misses / w.compressed) * 100).toFixed(1)}% (${w.misses}/${w.compressed})` : "n/a";
    const cost = `${Math.round(w.refetchBytes / BYTES_PER_TOKEN).toLocaleString("en-US")} tok`;
    lines.push(`  ${k}                         ${rate.padEnd(16)} ${cost}`);
  }
  lines.push("  re-read cost = native re-reads after compact output in this repo (bytes/4 estimate)");
  return lines.join("\n");
}
