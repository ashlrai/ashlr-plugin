/**
 * Accurate savings accounting — v1.18 "Trust Pass" graduates this from the
 * Day-1 pass-through into the correct cache-hit math.
 *
 * Background: `recordSaving(raw, compact, tool)` records `raw - compact` as
 * the delta. For a first-time call that's correct: Claude *would have*
 * received `raw` bytes of tool output, but we compressed it to `compact`.
 *
 * Cache-hit case is different: on a hit we served the cached compact
 * result, so Claude received exactly `compact` bytes again. But the value
 * proposition of the hit is that Claude *didn't have to pay* for the
 * counterfactual re-fetch — so the savings are the full `rawBytes` of the
 * source payload, not `raw - compact`.
 *
 * Concretely, the existing math on the first call already saved
 * `raw - compact`. On each subsequent hit, reporting only `raw - compact`
 * *again* under-counts — we should report `rawBytes` worth of work that
 * the cache shortcut entirely. We do this by recording the hit as
 * `(rawBytes, 0)` so `recordSaving` attributes the full `rawBytes` of
 * counterfactual cost to savings.
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
   * On a hit the accounting records `(rawBytes, 0)` — the full source
   * payload is saved because the cache shortcut skipped the re-fetch.
   */
  cacheHit: boolean;
}

/**
 * Record a savings event with cache-hit awareness.
 *
 * Miss: forwards `(rawBytes, compactBytes)` unchanged — normal delta math.
 * Hit:  forwards `(rawBytes, 0)` — the full source payload's token cost was
 *       avoided because the cache served a compact copy at near-zero cost.
 *
 * Also emits an `accounting_cache_hit` event so we can measure hit rates
 * over time and validate the correction.
 */
export async function recordSavingAccurate(opts: RecordSavingAccurateOpts): Promise<void> {
  const { rawBytes, compactBytes, toolName, cacheHit } = opts;

  if (cacheHit) {
    // Emit telemetry first (never blocks the stats write on the event log).
    await logEvent("accounting_cache_hit", {
      tool: toolName,
      extra: {
        rawBytes,
        compactBytes,
        // Savings attributed on this call — for a hit, the full source bytes.
        savedTokens: Math.max(0, Math.ceil(rawBytes / 4)),
      },
    }).catch(() => undefined);

    // Cache hit: full rawBytes of counterfactual cost avoided. Pass 0 as
    // the compact size so recordSaving credits the full source.
    await recordSaving(rawBytes, 0, toolName);
    return;
  }

  // Miss: standard delta.
  await recordSaving(rawBytes, compactBytes, toolName);
}
