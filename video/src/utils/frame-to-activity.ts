/**
 * Maps a composition frame index to `(frame, msSinceActive)` inputs the
 * status-line renderer consumes. Activity timestamps come from a hand-picked
 * timeline so the sparkline pulse fires at script-accurate moments in the
 * hero video — see video/src/fixtures/hero-session.json.
 */

import { FRAME_MS } from "../../../servers/_status-line-cells";

export interface ActivityEvent {
  /** Composition frame at which a "saving just happened" event fires. */
  atFrame: number;
}

export interface FrameActivity {
  /** Frame index for the CLI renderer (120 ms / step). */
  clFrame: number;
  /** ms since the most recent activity event, or Infinity if none yet. */
  msSinceActive: number;
}

/**
 * Convert composition frame (at `fps`) to the status-line renderer's own
 * clock, and compute how long it has been since the most recent activity
 * event in `events`.
 */
export function frameToActivity(
  compositionFrame: number,
  fps: number,
  events: readonly ActivityEvent[],
): FrameActivity {
  const elapsedMs = (compositionFrame / fps) * 1000;
  const clFrame = Math.floor(elapsedMs / FRAME_MS);

  let msSinceActive = Infinity;
  for (const e of events) {
    if (e.atFrame <= compositionFrame) {
      const eventMs = (e.atFrame / fps) * 1000;
      const delta = elapsedMs - eventMs;
      if (delta < msSinceActive) msSinceActive = delta;
    }
  }

  return { clFrame, msSinceActive };
}
