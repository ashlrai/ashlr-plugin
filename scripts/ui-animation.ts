/**
 * CLI wrapper around the pure status-line cell renderer at
 * `servers/_status-line-cells.ts`. This module is responsible only for
 * (a) re-exporting the pure helpers so existing callers keep working, and
 * (b) producing ANSI-escaped strings for terminal output.
 *
 * The actual animation logic — gradient sweep, pulse, heartbeat, context
 * pressure — lives in `_status-line-cells.ts` and is consumed in structured
 * form by the Remotion hero-video renderer. Both CLI and video render from
 * exactly the same cell decisions; see `docs/hero-video-script.md` for the
 * video side.
 */

import {
  cellsToAnsi,
  activityCell,
  contextPressureCells,
  heartbeatCell,
  sparklineCells,
  lerpColor,
  valuesToRamp,
  gradientTs,
  computePulse,
  sweepFactor,
  detectCapability,
  frameAt,
  ACTIVITY_ACTIVE_MS,
  ACTIVITY_GLYPH_ASCII,
  ACTIVITY_GLYPH_UNICODE,
  ASCII_RAMP,
  BRAND_DARK,
  BRAND_LIGHT,
  FRAME_MS,
  HEARTBEAT_ASCII_ACTIVE,
  HEARTBEAT_ASCII_IDLE,
  HEARTBEAT_FRAMES,
  HEARTBEAT_IDLE,
  PULSE_CELL,
  UNICODE_RAMP,
  type Capability,
  type Cell,
  type PulseState,
  type RGB,
  type SparklineInput,
} from "../servers/_status-line-cells";

// Re-export the pure API for backward compatibility with existing callers.
export {
  cellsToAnsi,
  activityCell,
  contextPressureCells,
  heartbeatCell,
  sparklineCells,
  lerpColor,
  valuesToRamp,
  gradientTs,
  computePulse,
  sweepFactor,
  detectCapability,
  frameAt,
  ACTIVITY_ACTIVE_MS,
  ACTIVITY_GLYPH_ASCII,
  ACTIVITY_GLYPH_UNICODE,
  ASCII_RAMP,
  BRAND_DARK,
  BRAND_LIGHT,
  FRAME_MS,
  HEARTBEAT_ASCII_ACTIVE,
  HEARTBEAT_ASCII_IDLE,
  HEARTBEAT_FRAMES,
  HEARTBEAT_IDLE,
  PULSE_CELL,
  UNICODE_RAMP,
  type Capability,
  type Cell,
  type PulseState,
  type RGB,
  type SparklineInput,
};

// ---------------------------------------------------------------------------
// ANSI string renderers (thin wrappers around the Cell[] producers)
// ---------------------------------------------------------------------------

export interface RenderSparklineInput {
  values: readonly number[];
  frame: number;
  msSinceActive: number;
  cap: Capability;
}

export function renderSparkline(input: RenderSparklineInput): string {
  return cellsToAnsi(sparklineCells(input));
}

export function renderHeartbeat(frame: number, msSinceActive: number, cap: Capability): string {
  return cellsToAnsi([heartbeatCell(frame, msSinceActive, cap)]);
}

export function activityIndicator(msSinceActive: number, cap: Capability): string {
  const cell = activityCell(msSinceActive, cap);
  return cell ? cellsToAnsi([cell]) : "";
}

export function renderContextPressure(pct: number, cap: Capability): string {
  return cellsToAnsi(contextPressureCells(pct, cap));
}

// ---------------------------------------------------------------------------
// Width helper (kept here — it only matters for CLI output)
// ---------------------------------------------------------------------------

/**
 * Visible character width of a rendered string — strips ANSI escapes. Used
 * by the status line to enforce its 80-column budget regardless of color.
 */
export function visibleWidth(s: string): number {
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  return Array.from(stripped).length;
}
