/**
 * Accurate savings accounting — Day-1 pass-through that starts collecting
 * cache-hit telemetry so we can measure real hit rates before fixing the math.
 *
 * Background: `recordSaving(raw, compact, tool)` records `raw - compact` bytes
 * saved on every call — even cache hits, where the agent never paid the raw
 * cost at all (it got the cached compact result). The paradox: we under-count
 * on cache hits because we log only the diff, not the full raw bytes.
 *
 * Fix (Day-1): The math stays the same for now. We wire in `cacheHit` so the
 * `accounting_cache_hit` event stream fills up, and a follow-up PR can adjust
 * the math once we know typical hit rates.
 *
 * Usage:
 *   import { recordSavingAccurate } from "./_accounting";
 *   await recordSavingAccurate({ rawBytes, compactBytes, toolName, cacheHit });
 */

import { recordSaving } from "./_stats";
import { logEvent } from "./_events";

export interface RecordSavingAccurateOpts {
  /** Raw bytes before compression / summarization. */
  rawBytes: number;
  /** Compact bytes after compression / summarization. */
  compactBytes: number;
  /** Tool name for stats bucketing (e.g. "ashlr__webfetch"). */
  toolName: string;
  /**
   * True if the result was served from the SHA-256 summary cache.
   * Day-1: used only for telemetry (accounting_cache_hit event).
   * Future PR: will record rawBytes as fully-saved on cache hits.
   */
  cacheHit: boolean;
}

/**
 * Record a savings event with cache-hit awareness.
 *
 * Day-1 behaviour: identical to recordSaving() — the delta is always
 * rawBytes - compactBytes. The cacheHit flag is forwarded as a logEvent
 * so hit rates can be measured before the math changes.
 */
export async function recordSavingAccurate(opts: RecordSavingAccurateOpts): Promise<void> {
  const { rawBytes, compactBytes, toolName, cacheHit } = opts;

  // Emit telemetry — this is the whole point of Day-1 wiring.
  if (cacheHit) {
    await logEvent("accounting_cache_hit", {
      tool: toolName,
      extra: {
        rawBytes,
        compactBytes,
        // Under-counted savings on this call (full rawBytes should be saved).
        underCountedTokens: Math.max(0, Math.ceil(compactBytes / 4)),
      },
    }).catch(() => undefined);
  }

  // Pass through to the existing accounting path (math unchanged for now).
  await recordSaving(rawBytes, compactBytes, toolName);
}
