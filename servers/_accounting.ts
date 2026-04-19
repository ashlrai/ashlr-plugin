/**
 * Savings accounting wrapper.
 *
 * Motivation: when `_summarize.ts` returns a cached summary, the CURRENT call
 * flow records saving(rawBytes, summaryBytes) — same as an uncached summary.
 * That is arguably over-crediting cache hits: the agent likely still holds
 * the previous summary in its context (prompt cache), so the second read did
 * not save another (rawBytes - summaryBytes) worth of model input. It re-used
 * what was already there.
 *
 * This module is the single hook where per-call saving is recorded so the
 * accounting policy can evolve in one place. All tool handlers should call
 * `recordSavingAccurate()` instead of the raw `recordSaving()` from
 * `_stats.ts`, and pass the `cacheHit` flag from the summarizer result.
 *
 * DAY-1 BEHAVIOR: identical to `recordSaving()`. Track D owns the
 * cache-hit-aware policy change; this wrapper exists so Track D's change
 * is a one-line flip here instead of a codebase-wide edit.
 */

import { recordSaving } from "./_stats";
import { logEvent } from "./_events";

export interface SavingEvent {
  /** Bytes that would have been emitted without ashlr compression. */
  rawBytes: number;
  /** Bytes actually emitted to the model. */
  compactBytes: number;
  /** Tool name, e.g. "ashlr__read". */
  toolName: string;
  /** True when the compact result came from the summarizer cache. */
  cacheHit?: boolean;
  /** Override session id (for test harness). */
  sessionId?: string;
}

/**
 * Preferred saving-record entry point for all tool handlers.
 *
 * Returns the tokens-saved delta actually recorded. Never throws. Under Track
 * D's cache-aware policy, a `cacheHit:true` event may be partially or fully
 * discounted; until that ships, the return value matches legacy semantics.
 */
export async function recordSavingAccurate(event: SavingEvent): Promise<number> {
  // Day-1 behavior: pass-through to _stats.recordSaving. The `cacheHit` flag
  // is emitted as an observability event so we can measure the frequency
  // before deciding the right discount. Track D flips the math once the
  // event stream shows stable hit rates.
  if (event.cacheHit) {
    await logEvent("accounting_cache_hit", {
      tool: event.toolName,
      extra: {
        rawBytes: event.rawBytes,
        compactBytes: event.compactBytes,
      },
    });
  }
  return recordSaving(event.rawBytes, event.compactBytes, event.toolName, {
    sessionId: event.sessionId,
  });
}
