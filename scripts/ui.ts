/**
 * ashlr UI helpers — zero-dependency ANSI utilities for colored terminal
 * output, Unicode symbols, spinners, progress bars, and bordered boxes.
 *
 * All helpers respect:
 *   - `NO_COLOR=1` (https://no-color.org) — disables all color/animation
 *   - `FORCE_COLOR=1` — forces color even when !isTTY
 *   - `!process.stdout.isTTY` — disables color/spinners/animation in pipes/CI
 *
 * Designed so that ANSI escapes never leak into scraped output, tests, or
 * logs. When colors are disabled, every `c.*()` helper returns the input
 * string verbatim and every symbol falls back to a plain ASCII approximation
 * when the environment hints that UTF-8 isn't safe.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

function detectColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  // stdout may not exist in some runtimes (e.g. Workers); treat as no-color.
  const tty = typeof process.stdout?.isTTY === "boolean" ? process.stdout.isTTY : false;
  return tty;
}

function detectStderrTTY(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  const tty = typeof process.stderr?.isTTY === "boolean" ? process.stderr.isTTY : false;
  return tty;
}

/** Cached capability so repeated calls are cheap. */
let _colorEnabled: boolean | null = null;
/** Cached stderr TTY capability for spinners. */
let _stderrTTY: boolean | null = null;

export function isColorEnabled(): boolean {
  if (_colorEnabled === null) _colorEnabled = detectColor();
  return _colorEnabled;
}

export function isStderrTTY(): boolean {
  if (_stderrTTY === null) _stderrTTY = detectStderrTTY();
  return _stderrTTY;
}

/** Test hook — reset cached capability detection. */
export function _resetCapCache(): void {
  _colorEnabled = null;
  _stderrTTY = null;
}

// ---------------------------------------------------------------------------
// ANSI primitives
// ---------------------------------------------------------------------------

const ESC = "\u001b[";
const RESET = `${ESC}0m`;

function wrap(open: string, close: string, s: string): string {
  if (!isColorEnabled()) return s;
  return `${ESC}${open}m${s}${ESC}${close}m`;
}

// ---------------------------------------------------------------------------
// Colors and text styles
// ---------------------------------------------------------------------------

export const c = {
  // Foreground colors
  black: (s: string): string => wrap("30", "39", s),
  red: (s: string): string => wrap("31", "39", s),
  green: (s: string): string => wrap("32", "39", s),
  yellow: (s: string): string => wrap("33", "39", s),
  blue: (s: string): string => wrap("34", "39", s),
  magenta: (s: string): string => wrap("35", "39", s),
  cyan: (s: string): string => wrap("36", "39", s),
  white: (s: string): string => wrap("37", "39", s),
  gray: (s: string): string => wrap("90", "39", s),

  // Styles
  bold: (s: string): string => wrap("1", "22", s),
  dim: (s: string): string => wrap("2", "22", s),
  italic: (s: string): string => wrap("3", "23", s),
  underline: (s: string): string => wrap("4", "24", s),
  inverse: (s: string): string => wrap("7", "27", s),

  // Bright variants — useful for emphasis without `bold` side-effects.
  brightGreen: (s: string): string => wrap("92", "39", s),
  brightRed: (s: string): string => wrap("91", "39", s),
  brightYellow: (s: string): string => wrap("93", "39", s),
  brightCyan: (s: string): string => wrap("96", "39", s),
  brightMagenta: (s: string): string => wrap("95", "39", s),
};

// ---------------------------------------------------------------------------
// Symbols (UTF-8 glyphs with ASCII fallbacks)
// ---------------------------------------------------------------------------

/** Best-effort UTF-8 detection. Terminals that say UTF-8 in LANG or advertise
 *  a UTF-8 locale get the nice glyphs; everything else falls back to ASCII. */
function supportsUnicode(): boolean {
  if (process.platform === "win32") {
    // Modern Windows Terminal / ConEmu handle Unicode fine; naive cmd.exe may
    // not. We favor glyphs here and let users set NO_COLOR if they need pure
    // ASCII.
    return true;
  }
  const l = (process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "").toLowerCase();
  return l.includes("utf");
}

const UTF = supportsUnicode();

export const sym = {
  check: UTF ? "\u2713" : "v", //  ✓
  cross: UTF ? "\u2717" : "x", //  ✗
  warn: UTF ? "\u26A0" : "!",  //  ⚠
  info: UTF ? "\u2139" : "i",  //  ℹ
  arrow: UTF ? "\u2192" : "->", // →
  dot: UTF ? "\u00B7" : ".",   //  ·
  bullet: UTF ? "\u2022" : "*",//  •
  star: UTF ? "\u2605" : "*",  //  ★
  circle: UTF ? "\u25CB" : "o",//  ○
  filled: UTF ? "\u25CF" : "@",//  ●
  ellipsis: UTF ? "\u2026" : "...",
  // Box-drawing
  tl: UTF ? "\u256D" : "+",    //  ╭
  tr: UTF ? "\u256E" : "+",    //  ╮
  bl: UTF ? "\u2570" : "+",    //  ╰
  br: UTF ? "\u256F" : "+",    //  ╯
  h: UTF ? "\u2500" : "-",     //  ─
  v: UTF ? "\u2502" : "|",     //  │
};

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
// Braille spinner — same as ora's default. Smooth on any modern terminal.

const CURSOR_HIDE = `${ESC}?25l`;
const CURSOR_SHOW = `${ESC}?25h`;
const CLEAR_LINE = `${ESC}2K\r`;

export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private message: string;
  private stream: NodeJS.WriteStream;
  private enabled: boolean;
  private started = false;

  constructor(message = "", opts: { stream?: NodeJS.WriteStream } = {}) {
    this.message = message;
    this.stream = opts.stream ?? process.stderr;
    // Only animate when stderr is a real TTY. No-color disables the glyph
    // color but spinners themselves only make sense on a TTY anyway.
    this.enabled = isStderrTTY();
  }

  /** Start the spinner. If already started, updates the message instead. */
  start(message?: string): this {
    if (message !== undefined) this.message = message;
    if (!this.enabled) {
      // Non-TTY: stay silent. Callers still get to drive succeed/fail/info
      // messages explicitly, which render as plain prefixed lines below.
      this.started = true;
      return this;
    }
    if (this.timer) return this; // already animating
    this.stream.write(CURSOR_HIDE);
    this.started = true;
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 80);
    // Best-effort cleanup on hard exits.
    const cleanup = () => this.stop();
    process.once("exit", cleanup);
    process.once("SIGINT", () => { cleanup(); process.exit(130); });
    return this;
  }

  update(message: string): this {
    this.message = message;
    if (this.enabled && this.timer) this.render();
    return this;
  }

  succeed(message?: string): this {
    const msg = message ?? this.message;
    this.stop();
    if (!this.enabled) return this; // stay quiet on non-TTY
    const glyph = isColorEnabled() ? c.green(sym.check) : sym.check;
    this.stream.write(`${glyph} ${msg}\n`);
    return this;
  }

  fail(message?: string): this {
    const msg = message ?? this.message;
    this.stop();
    if (!this.enabled) {
      // Failures are actionable — surface them even on non-TTY, but without
      // ANSI.
      this.stream.write(`${sym.cross} ${msg}\n`);
      return this;
    }
    const glyph = isColorEnabled() ? c.red(sym.cross) : sym.cross;
    this.stream.write(`${glyph} ${msg}\n`);
    return this;
  }

  warn(message?: string): this {
    const msg = message ?? this.message;
    this.stop();
    if (!this.enabled) return this;
    const glyph = isColorEnabled() ? c.yellow(sym.warn) : sym.warn;
    this.stream.write(`${glyph} ${msg}\n`);
    return this;
  }

  info(message?: string): this {
    const msg = message ?? this.message;
    this.stop();
    if (!this.enabled) return this;
    const glyph = isColorEnabled() ? c.cyan(sym.info) : sym.info;
    this.stream.write(`${glyph} ${msg}\n`);
    return this;
  }

  /** Stop the animation without printing a final line. */
  stop(): this {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled && this.started) {
      this.stream.write(CLEAR_LINE);
      this.stream.write(CURSOR_SHOW);
    }
    this.started = false;
    return this;
  }

  private render(): void {
    const frame = SPINNER_FRAMES[this.frame]!;
    const colored = isColorEnabled() ? c.cyan(frame) : frame;
    this.stream.write(`${CLEAR_LINE}${colored} ${this.message}`);
  }
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

export interface ProgressBarOpts {
  width?: number;
  stream?: NodeJS.WriteStream;
}

export class ProgressBar {
  private total = 0;
  private current = 0;
  private label = "";
  private width: number;
  private stream: NodeJS.WriteStream;
  private enabled: boolean;
  private started = false;
  private lastLen = 0;

  constructor(opts: ProgressBarOpts = {}) {
    this.width = opts.width ?? 24;
    this.stream = opts.stream ?? process.stderr;
    this.enabled = isStderrTTY();
  }

  start(total: number, label = ""): this {
    this.total = Math.max(0, total);
    this.current = 0;
    this.label = label;
    this.started = true;
    if (this.enabled) {
      this.stream.write(CURSOR_HIDE);
      this.render();
    }
    // Non-TTY: stay silent. Progress is inherently a TTY-only UX.
    return this;
  }

  increment(n = 1): this {
    this.current = Math.min(this.total, this.current + n);
    if (this.enabled && this.started) this.render();
    return this;
  }

  update(current: number): this {
    this.current = Math.min(this.total, Math.max(0, current));
    if (this.enabled && this.started) this.render();
    return this;
  }

  finish(message?: string): this {
    if (this.enabled && this.started) {
      this.stream.write(CLEAR_LINE);
      this.stream.write(CURSOR_SHOW);
    }
    this.started = false;
    if (message && this.enabled) {
      const glyph = isColorEnabled() ? c.green(sym.check) : sym.check;
      this.stream.write(`${glyph} ${message}\n`);
    }
    return this;
  }

  private render(): void {
    const pct = this.total > 0 ? this.current / this.total : 0;
    const filled = Math.round(pct * this.width);
    const empty = this.width - filled;
    const bar = UTF ? "\u2588".repeat(filled) + "\u2591".repeat(empty) : "#".repeat(filled) + "-".repeat(empty);
    const coloredBar = isColorEnabled() ? c.cyan(bar) : bar;
    const pctStr = `${Math.round(pct * 100)}%`;
    const countStr = `${this.current}/${this.total}`;
    const label = this.label ? ` ${this.label}` : "";
    const line = `[${coloredBar}] ${countStr} (${isColorEnabled() ? c.dim(pctStr) : pctStr})${label}`;
    this.stream.write(`${CLEAR_LINE}${line}`);
    this.lastLen = line.length;
  }
}

// ---------------------------------------------------------------------------
// Box
// ---------------------------------------------------------------------------

export interface BoxOpts {
  title?: string;
  /** Color applied to the border + title. */
  color?: (s: string) => string;
  /** Horizontal padding inside the box. Default 1. */
  padding?: number;
}

/** Strip ANSI codes so we can measure visible width. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function visibleWidth(s: string): number {
  // Naive: one codepoint = one column. Good enough for our ASCII+glyph usage.
  return [...stripAnsi(s)].length;
}

function padRight(s: string, target: number): string {
  const pad = target - visibleWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

export function box(content: string, opts: BoxOpts = {}): string {
  const padding = opts.padding ?? 1;
  const color = opts.color ?? ((s: string) => s);

  const rawLines = content.split("\n");
  const titleLen = opts.title ? visibleWidth(opts.title) + 2 /* spaces */ : 0;
  const contentW = Math.max(...rawLines.map(visibleWidth), titleLen);
  const innerW = contentW + padding * 2;

  const h = color(sym.h);
  const v = color(sym.v);
  const tl = color(sym.tl);
  const tr = color(sym.tr);
  const bl = color(sym.bl);
  const br = color(sym.br);

  // Top border with optional title
  let top: string;
  if (opts.title) {
    const titleText = color(isColorEnabled() ? c.bold(opts.title) : opts.title);
    const titleBlock = ` ${titleText} `;
    const remaining = innerW - visibleWidth(titleBlock);
    const left = Math.max(1, Math.floor(remaining / 2));
    const right = Math.max(1, remaining - left);
    top = tl + h.repeat(left) + titleBlock + h.repeat(right) + tr;
  } else {
    top = tl + h.repeat(innerW) + tr;
  }

  const bottom = bl + h.repeat(innerW) + br;
  const pad = " ".repeat(padding);

  const body = rawLines.map((line) => {
    const padded = padRight(line, contentW);
    return `${v}${pad}${padded}${pad}${v}`;
  });

  return [top, ...body, bottom].join("\n");
}

// ---------------------------------------------------------------------------
// Banner — small ASCII-art logo
// ---------------------------------------------------------------------------

/** Renders a small gradient-colored banner. `text` defaults to "ashlr". */
export function banner(text = "ashlr"): string {
  // Simple ASCII-art: block-style lettering built from Unicode block chars.
  // We keep this short and readable; full figlet-style ASCII art would blow
  // up the vertical real estate.
  const line1 = `${sym.filled}  ${text}`;
  const line2 = `${sym.h.repeat(Math.max(text.length + 3, 6))}`;
  if (!isColorEnabled()) return `${line1}\n${line2}`;
  return `${c.brightMagenta(c.bold(line1))}\n${c.dim(line2)}`;
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Colored check/cross prefix helpers for quick status lines. */
export const prefix = {
  ok: (s: string): string => (isColorEnabled() ? `${c.green(sym.check)} ${s}` : `${sym.check} ${s}`),
  fail: (s: string): string => (isColorEnabled() ? `${c.red(sym.cross)} ${s}` : `${sym.cross} ${s}`),
  warn: (s: string): string => (isColorEnabled() ? `${c.yellow(sym.warn)} ${s}` : `${sym.warn} ${s}`),
  info: (s: string): string => (isColorEnabled() ? `${c.cyan(sym.info)} ${s}` : `${sym.info} ${s}`),
  arrow: (s: string): string => (isColorEnabled() ? `${c.magenta(sym.arrow)} ${s}` : `${sym.arrow} ${s}`),
};
