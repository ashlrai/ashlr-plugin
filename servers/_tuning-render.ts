/**
 * _tuning-render.ts: "self-tuning" section of /ashlr savings.
 *
 * Net tokens saved per ISO week = tokens saved that week minus native
 * re-fetch bytes after misses / 4. The re-fetch side is a bytes/4 estimate,
 * so net figures are labeled "est.". Miss rate = misses / compressed results.
 */

import { isoWeek, readRepoMissFile, trackingEnabled } from "./_miss-tracker";

export const BYTES_PER_TOKEN = 4;
export const WEEKS_SHOWN = 4;

export function renderTuningSection(
  byDay: Record<string, { tokensSaved?: number }>,
  homeDir: string,
  cwd: string = process.cwd(),
  now: number = Date.now(),
): string | null {
  if (!trackingEnabled()) return "self-tuning: off (ASHLR_TUNING=off)";
  const { weeks } = readRepoMissFile(homeDir, cwd);
  const saved: Record<string, number> = {};
  for (const [day, b] of Object.entries(byDay ?? {})) {
    const w = isoWeek(Date.parse(`${day}T12:00:00Z`));
    saved[w] = (saved[w] ?? 0) + (b?.tokensSaved ?? 0);
  }
  const keys: string[] = [];
  for (let i = WEEKS_SHOWN - 1; i >= 0; i--) keys.push(isoWeek(now - i * 7 * 86400000));
  if (!keys.some((k) => weeks[k])) return null;
  const lines = ["self-tuning (this repo)   net tok (est.)   miss rate"];
  for (const k of keys) {
    const w = weeks[k] ?? { compressed: 0, misses: 0, refetchBytes: 0 };
    const net = (saved[k] ?? 0) - Math.round(w.refetchBytes / BYTES_PER_TOKEN);
    const rate = w.compressed > 0 ? `${((w.misses / w.compressed) * 100).toFixed(1)}% (${w.misses}/${w.compressed})` : "n/a";
    lines.push(`  ${k}   ${net.toLocaleString("en-US").padStart(14)}   ${rate}`);
  }
  lines.push("  net = saved minus native re-reads after compact output (bytes/4 estimate)");
  return lines.join("\n");
}
