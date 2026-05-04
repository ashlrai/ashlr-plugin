/**
 * Pure, deterministic status-line renderer — structured output.
 *
 * This module is the single source of truth for every visual decision the
 * animated status line makes. It returns `Cell[]` (a char + optional color +
 * optional bold) instead of ANSI-escaped strings, so two consumers can share
 * exactly the same animation logic:
 *
 *   1. `scripts/ui-animation.ts` — the CLI wrapper. Calls the cell producers
 *      here, then serializes Cell[] into ANSI escapes for the terminal.
 *   2. `video/src/compositions/StatusLineStill.tsx` — the Remotion port.
 *      Calls the same cell producers, then renders each cell as a `<span>`
 *      with inline RGB styles for the hero video.
 *
 * Zero Node deps, zero I/O, zero `Date` calls. Every function is
 * `(values, frame, msSinceActive, capability) -> something deterministic`.
 * Test golden-frames without mocking the clock.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Cell {
  /** Visible character (single grapheme). */
  char: string;
  /** Foreground RGB. Absent means "use terminal default / inherited color". */
  fg?: RGB;
  /** Bold styling. */
  bold?: boolean;
  /**
   * True when this cell is part of an active pulse/activity effect. Downstream
   * renderers (especially the Remotion port) can use this to emit extra
   * animation hints like a glow filter.
   */
  activity?: boolean;
}

export interface Capability {
  /** Terminal supports 24-bit color escapes. */
  truecolor: boolean;
  /** Terminal supports Unicode. False falls through to ASCII ramps. */
  unicode: boolean;
  /** Master animation switch. False emits a single static frame. */
  animate: boolean;
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

export function detectCapability(env: NodeJS.ProcessEnv = process.env): Capability {
  const noColor = truthyEnv(env.NO_COLOR);
  const animateOff = env.ASHLR_STATUS_ANIMATE === "0";
  const forceAnimate = env.ASHLR_STATUS_ANIMATE === "1";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  const term = (env.TERM ?? "").toLowerCase();
  const truecolor = !noColor && (colorterm === "truecolor" || colorterm === "24bit" || forceAnimate);
  const lang = (env.LANG ?? env.LC_ALL ?? env.LC_CTYPE ?? "").toLowerCase();
  const unicode = lang.includes("utf") || term.includes("xterm") || term.includes("256color") || truecolor;
  const animate = !animateOff && (truecolor || forceAnimate);
  return { truecolor, unicode, animate };
}

function truthyEnv(v: string | undefined): boolean {
  if (v == null) return false;
  const t = v.trim().toLowerCase();
  return t !== "" && t !== "0" && t !== "false" && t !== "no";
}

// ---------------------------------------------------------------------------
// Frame clock
// ---------------------------------------------------------------------------

export const FRAME_MS = 120;

/** Integer frame index for a given wall-clock ms. */
export function frameAt(nowMs: number, frameMs: number = FRAME_MS): number {
  return Math.floor(nowMs / frameMs);
}

// ---------------------------------------------------------------------------
// Sparkline glyph ramps
// ---------------------------------------------------------------------------

export const UNICODE_RAMP: readonly string[] = [
  "\u2800",
  "\u2840",
  "\u2844",
  "\u2846",
  "\u2847",
  "\u28E7",
  "\u28F7",
  "\u28FF",
  "\u2581",
  "\u2582",
  "\u2583",
  "\u2584",
  "\u2585",
  "\u2586",
  "\u2587",
  "\u2588",
];

export const ASCII_RAMP: readonly string[] = [" ", ".", ":", "|", "#"];

function pickRamp(cap: Capability): readonly string[] {
  return cap.unicode ? UNICODE_RAMP : ASCII_RAMP;
}

export function valuesToRamp(values: readonly number[], rampLen: number): number[] {
  const max = Math.max(...values, 0);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => {
    if (v <= 0) return 0;
    const last = rampLen - 1;
    return Math.max(1, Math.min(last, Math.ceil((v / max) * last)));
  });
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

export const BRAND_DARK: RGB = { r: 0, g: 208, b: 156 }; // #00d09c
export const BRAND_LIGHT: RGB = { r: 124, g: 255, b: 214 }; // #7cffd6
export const PULSE_CELL: RGB = { r: 255, g: 255, b: 255 };

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

export function lerpColor(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

// ---------------------------------------------------------------------------
// Gradient sweep + activity pulse math
// ---------------------------------------------------------------------------

export function gradientTs(width: number, frame: number): number[] {
  if (width <= 0) return [];
  if (width === 1) return [0];
  const ts: number[] = [];
  const phase = ((frame % (width * 2)) + width * 2) % (width * 2);
  for (let i = 0; i < width; i++) {
    const shifted = (i + phase) % (width * 2);
    const raw = shifted < width ? shifted / (width - 1) : (width * 2 - 1 - shifted) / (width - 1);
    ts.push(raw);
  }
  return ts;
}

export interface PulseState {
  /** Linear position 0..1 along the sparkline (wraps). */
  position: number;
  /** Intensity 0..1 used to blend the pulse color over the base cell. */
  intensity: number;
}

export function computePulse(frame: number, msSinceActive: number, width: number): PulseState {
  if (!Number.isFinite(msSinceActive) || msSinceActive < 0 || width <= 0) {
    return { position: 0, intensity: 0 };
  }
  const ACTIVE_MS = 4_000;
  const FADE_MS = 500;
  let intensity: number;
  if (msSinceActive <= ACTIVE_MS) intensity = 1;
  else if (msSinceActive <= ACTIVE_MS + FADE_MS) {
    intensity = 1 - (msSinceActive - ACTIVE_MS) / FADE_MS;
  } else intensity = 0;
  const position = ((frame % (width * 3)) + width * 3) % (width * 3) / (width * 3);
  return { position, intensity };
}

export function sweepFactor(cellIndex: number, headCell: number, width: number): number {
  const w = Math.max(1, width);
  const delta = ((cellIndex - headCell) % w + w) % w;
  if (delta === 0) return 1.0;
  if (delta === w - 1) return 0.45;
  if (delta === w - 2) return 0.15;
  return 0.0;
}

// ---------------------------------------------------------------------------
// Heartbeat glyph
// ---------------------------------------------------------------------------

export const HEARTBEAT_FRAMES = [
  "\u2840", "\u2844", "\u2846", "\u2847", "\u28C7",
  "\u28E7", "\u28F7", "\u28FF", "\u28F7", "\u28E7",
  "\u28C7", "\u2847", "\u2846", "\u2844", "\u2840",
] as const;
export const HEARTBEAT_IDLE = "\u00B7";
export const HEARTBEAT_ASCII_IDLE = ".";
export const HEARTBEAT_ASCII_ACTIVE = ["-", "=", "*", "=", "-"] as const;

const HEARTBEAT_IDLE_COLOR: RGB = { r: 100, g: 110, b: 120 };

// ---------------------------------------------------------------------------
// Context pressure widget
// ---------------------------------------------------------------------------

export const CTX_GREEN: RGB = { r: 0, g: 160, b: 120 };
export const CTX_YELLOW: RGB = { r: 212, g: 167, b: 44 };
export const CTX_ORANGE: RGB = { r: 217, g: 121, b: 58 };
export const CTX_RED: RGB = { r: 225, g: 91, b: 91 };

// ---------------------------------------------------------------------------
// Activity indicator
// ---------------------------------------------------------------------------

export const ACTIVITY_ACTIVE_MS = 4_000;
export const ACTIVITY_GLYPH_UNICODE = "\u2191";
export const ACTIVITY_GLYPH_ASCII = "+";

// ===========================================================================
// Cell producers — the public API the CLI and Remotion renderers both consume.
// ===========================================================================

export interface SparklineInput {
  values: readonly number[];
  frame: number;
  msSinceActive: number;
  cap: Capability;
}

/**
 * Build the sparkline as structured cells.
 *
 * When `cap.animate` or `cap.truecolor` is false, each cell has no `fg` (plain
 * terminal color) or a single brand-green `fg` depending on caller intent. In
 * the full animated case, each cell gets a gradient-interpolated base color
 * plus optional pulse overlay.
 */
export function sparklineCells({ values, frame, msSinceActive, cap }: SparklineInput): Cell[] {
  const ramp = pickRamp(cap);
  const idxs = valuesToRamp(values, ramp.length);
  const chars = idxs.map((i) => ramp[i]!);

  if (!cap.animate || !cap.truecolor) {
    return chars.map((char) => ({ char }));
  }

  const ts = gradientTs(chars.length, frame);
  const pulse = computePulse(frame, msSinceActive, chars.length);
  const headCell = pulse.intensity > 0
    ? Math.floor(pulse.position * chars.length) % chars.length
    : -1;

  return chars.map((char, i) => {
    const base = lerpColor(BRAND_DARK, BRAND_LIGHT, ts[i] ?? 0);
    let color = base;
    let activity = false;
    if (headCell >= 0) {
      const factor = sweepFactor(i, headCell, chars.length) * pulse.intensity;
      if (factor > 0) {
        color = lerpColor(base, PULSE_CELL, factor);
        activity = true;
      }
    }
    const cell: Cell = { char, fg: color };
    if (activity) cell.activity = true;
    return cell;
  });
}

/**
 * Single-cell heartbeat glyph (goes between "ashlr" and the sparkline).
 */
export function heartbeatCell(frame: number, msSinceActive: number, cap: Capability): Cell {
  const active = msSinceActive <= 4_500;
  if (!cap.animate) {
    return { char: cap.unicode ? HEARTBEAT_IDLE : HEARTBEAT_ASCII_IDLE };
  }
  if (!active) {
    const idle = cap.unicode ? HEARTBEAT_IDLE : HEARTBEAT_ASCII_IDLE;
    return cap.truecolor
      ? { char: idle, fg: HEARTBEAT_IDLE_COLOR }
      : { char: idle };
  }
  const frames = cap.unicode ? HEARTBEAT_FRAMES : HEARTBEAT_ASCII_ACTIVE;
  const ch = frames[((frame % frames.length) + frames.length) % frames.length]!;
  if (!cap.truecolor) return { char: ch, activity: true };

  const ACTIVE_MS = 4_000;
  const FADE_MS = 500;
  const t = msSinceActive <= ACTIVE_MS
    ? 0
    : Math.min(1, (msSinceActive - ACTIVE_MS) / FADE_MS);
  const color = lerpColor(BRAND_LIGHT, BRAND_DARK, t);
  return { char: ch, fg: color, activity: true };
}

/**
 * Activity indicator next to the session counter. Returns `null` when idle so
 * the caller can omit the cell entirely (width stays stable — idle = 0 cells,
 * active = 1 cell).
 */
export function activityCell(msSinceActive: number, cap: Capability): Cell | null {
  if (!Number.isFinite(msSinceActive) || msSinceActive > ACTIVITY_ACTIVE_MS) return null;
  const glyph = cap.unicode ? ACTIVITY_GLYPH_UNICODE : ACTIVITY_GLYPH_ASCII;
  if (!cap.truecolor) return { char: glyph, activity: true };
  const t = msSinceActive / ACTIVITY_ACTIVE_MS;
  const color = lerpColor(BRAND_LIGHT, BRAND_DARK, t);
  return { char: glyph, fg: color, activity: true };
}

/**
 * Context-pressure micro-widget, rendered as a sequence of cells spelling out
 * e.g. `ctx: 72%`. Width is 8–9 visible cells depending on the percentage.
 *
 * When `cap.truecolor` is false every cell is returned without `fg` so the
 * caller renders in the terminal's default color.
 */
export function contextPressureCells(pct: number, cap: Capability): Cell[] {
  const label = `ctx: ${Math.round(pct)}%`;
  if (!cap.truecolor) return [...label].map((char) => ({ char }));

  let color: RGB;
  let bold = false;
  if (pct >= 95) {
    color = CTX_RED;
    bold = true;
  } else if (pct >= 80) {
    color = CTX_ORANGE;
  } else if (pct >= 60) {
    color = CTX_YELLOW;
  } else {
    color = CTX_GREEN;
  }

  return [...label].map((char) => {
    const cell: Cell = { char, fg: color };
    if (bold) cell.bold = true;
    return cell;
  });
}

// ---------------------------------------------------------------------------
// Budget segment — shows "$X / $Y · Z%" or "Nt / Nmax · Z%"
// ---------------------------------------------------------------------------

export const BUDGET_OK: RGB = { r: 0, g: 160, b: 120 };     // green
export const BUDGET_WARN: RGB = { r: 212, g: 167, b: 44 };  // yellow
export const BUDGET_CRIT: RGB = { r: 225, g: 91, b: 91 };   // red

/**
 * Return cells for the budget segment, or an empty array when no budget is set.
 *
 * When `ASHLR_SESSION_BUDGET_USD` is set renders: `$used / $cap · Z%`
 * When `ASHLR_SESSION_BUDGET_TOKENS` is set renders: `Nt / Nmax · Z%`
 */
export function budgetCells(
  usedUsd: number,
  budgetUsd: number,
  usedTokens: number,
  budgetTokens: number,
  cap: Capability,
): Cell[] {
  if (budgetUsd <= 0 && budgetTokens <= 0) return [];

  let label: string;
  let pct: number;

  if (budgetUsd > 0) {
    pct = budgetUsd > 0 ? usedUsd / budgetUsd : 0;
    label = `$${usedUsd.toFixed(2)} / $${budgetUsd.toFixed(2)} · ${Math.round(pct * 100)}%`;
  } else {
    pct = budgetTokens > 0 ? usedTokens / budgetTokens : 0;
    const usedK = usedTokens >= 1000 ? `${Math.round(usedTokens / 1000)}k` : String(usedTokens);
    const maxK = budgetTokens >= 1000 ? `${Math.round(budgetTokens / 1000)}k` : String(budgetTokens);
    label = `${usedK} / ${maxK} · ${Math.round(pct * 100)}%`;
  }

  if (!cap.truecolor) return [...label].map((char) => ({ char }));

  let color: RGB;
  let bold = false;
  if (pct >= 1.0) {
    color = BUDGET_CRIT;
    bold = true;
  } else if (pct >= 0.95) {
    color = BUDGET_CRIT;
  } else if (pct >= 0.80) {
    color = BUDGET_WARN;
  } else {
    color = BUDGET_OK;
  }

  return [...label].map((char) => {
    const cell: Cell = { char, fg: color };
    if (bold) cell.bold = true;
    return cell;
  });
}

// ---------------------------------------------------------------------------
// Eco badge — shows "eco" when ASHLR_ECO=1
// ---------------------------------------------------------------------------

export const ECO_COLOR: RGB = { r: 80, g: 200, b: 100 }; // leaf green

/**
 * Return cells for the eco badge, or empty array when eco mode is off.
 * Reads ASHLR_ECO from env unless overridden.
 */
export function ecoBadgeCells(
  cap: Capability,
  env: NodeJS.ProcessEnv = process.env,
): Cell[] {
  if (!env.ASHLR_ECO || env.ASHLR_ECO === "0") return [];
  const label = "eco";
  if (!cap.truecolor) return [...label].map((char) => ({ char }));
  return [...label].map((char) => ({ char, fg: ECO_COLOR }));
}

// ===========================================================================
// Cell → ANSI serialization (used by the CLI wrapper)
// ===========================================================================

const ANSI_RESET = "\x1b[0m";

function ansiFg(c: RGB): string {
  return `\x1b[38;2;${c.r};${c.g};${c.b}m`;
}

/**
 * Collapse a `Cell[]` into an ANSI-escaped string suitable for TTY output.
 * Runs of cells that share `(fg, bold)` share a single escape prefix so the
 * output stays compact and readable in a `cat`'d log.
 *
 * Callers who want no ANSI (raw character dump for width measurement) can just
 * join `cells.map(c => c.char)` directly.
 */
export function cellsToAnsi(cells: readonly Cell[]): string {
  if (cells.length === 0) return "";
  const parts: string[] = [];
  let last: { fg?: RGB; bold?: boolean } = {};
  let hadStyle = false;

  for (const cell of cells) {
    const sameFg =
      (cell.fg == null && last.fg == null) ||
      (cell.fg != null && last.fg != null &&
        cell.fg.r === last.fg.r && cell.fg.g === last.fg.g && cell.fg.b === last.fg.b);
    const sameBold = !!cell.bold === !!last.bold;
    if (!(sameFg && sameBold)) {
      if (hadStyle) parts.push(ANSI_RESET);
      if (cell.bold) parts.push("\x1b[1m");
      if (cell.fg) {
        parts.push(ansiFg(cell.fg));
        hadStyle = true;
      } else {
        hadStyle = !!cell.bold;
      }
      last = { fg: cell.fg, bold: cell.bold };
    }
    parts.push(cell.char);
  }
  if (hadStyle) parts.push(ANSI_RESET);
  return parts.join("");
}
