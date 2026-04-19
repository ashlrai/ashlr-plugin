/**
 * Tests for `servers/_status-line-cells.ts` — the pure cell-producing renderer
 * shared by the CLI status line and the Remotion hero-video composition.
 *
 * These tests target the structured output directly (no ANSI parsing) and
 * complement `__tests__/ui-animation.test.ts`, which covers the ANSI wrapper.
 */

import { describe, expect, test } from "bun:test";

import {
  activityCell,
  BRAND_DARK,
  BRAND_LIGHT,
  cellsToAnsi,
  contextPressureCells,
  CTX_ORANGE,
  CTX_RED,
  CTX_YELLOW,
  heartbeatCell,
  sparklineCells,
  type Capability,
  type Cell,
} from "../servers/_status-line-cells";

const TRUECOLOR: Capability = { truecolor: true, unicode: true, animate: true };
const PLAIN: Capability = { truecolor: false, unicode: true, animate: false };
const ASCII_ONLY: Capability = { truecolor: false, unicode: false, animate: false };

// ---------------------------------------------------------------------------
// sparklineCells
// ---------------------------------------------------------------------------

describe("sparklineCells", () => {
  const values = [10, 20, 40, 80, 60, 30, 5];

  test("truecolor + animate: every cell has an fg color", () => {
    const cells = sparklineCells({ values, frame: 0, msSinceActive: Infinity, cap: TRUECOLOR });
    expect(cells).toHaveLength(values.length);
    for (const c of cells) {
      expect(c.fg).toBeDefined();
      expect(typeof c.fg!.r).toBe("number");
    }
  });

  test("static (no animate): cells carry no fg", () => {
    const cells = sparklineCells({ values, frame: 0, msSinceActive: Infinity, cap: PLAIN });
    for (const c of cells) {
      expect(c.fg).toBeUndefined();
      expect(c.activity).toBeUndefined();
    }
  });

  test("ASCII fallback: uses single-char ASCII ramp (# max)", () => {
    const cells = sparklineCells({ values, frame: 0, msSinceActive: Infinity, cap: ASCII_ONLY });
    const chars = new Set(cells.map((c) => c.char));
    for (const ch of chars) {
      expect(" .:|#".includes(ch)).toBe(true);
    }
  });

  test("active pulse marks some cells with activity=true", () => {
    const cells = sparklineCells({
      values,
      frame: 3,
      msSinceActive: 100,
      cap: TRUECOLOR,
    });
    const active = cells.filter((c) => c.activity);
    expect(active.length).toBeGreaterThan(0);
    expect(active.length).toBeLessThanOrEqual(3);
  });

  test("idle (msSinceActive > 4500): no activity cells", () => {
    const cells = sparklineCells({
      values,
      frame: 3,
      msSinceActive: 10_000,
      cap: TRUECOLOR,
    });
    expect(cells.every((c) => !c.activity)).toBe(true);
  });

  test("determinism: same inputs produce identical cells across calls", () => {
    const a = sparklineCells({ values, frame: 42, msSinceActive: 800, cap: TRUECOLOR });
    const b = sparklineCells({ values, frame: 42, msSinceActive: 800, cap: TRUECOLOR });
    expect(a).toEqual(b);
  });

  test("empty input -> empty output", () => {
    expect(sparklineCells({ values: [], frame: 0, msSinceActive: 0, cap: TRUECOLOR })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// heartbeatCell
// ---------------------------------------------------------------------------

describe("heartbeatCell", () => {
  test("no-animate: always the idle dot", () => {
    const c = heartbeatCell(100, 0, PLAIN);
    expect(c.char).toBe("\u00B7");
    expect(c.activity).toBeUndefined();
  });

  test("active + truecolor: glyph has fg color and activity=true", () => {
    const c = heartbeatCell(0, 100, TRUECOLOR);
    expect(c.activity).toBe(true);
    expect(c.fg).toBeDefined();
    // Right after a save, color should be near BRAND_LIGHT.
    expect(c.fg!.r).toBeGreaterThan(BRAND_DARK.r);
  });

  test("post-fade (msSinceActive > 4500): idle dim dot", () => {
    const c = heartbeatCell(10, 5_000, TRUECOLOR);
    expect(c.char).toBe("\u00B7");
    expect(c.activity).toBeUndefined();
    // Idle color is the dim grey.
    expect(c.fg).toEqual({ r: 100, g: 110, b: 120 });
  });

  test("ASCII fallback active: uses rotating ASCII frame", () => {
    const cap: Capability = { truecolor: false, unicode: false, animate: true };
    const c = heartbeatCell(0, 100, cap);
    expect("-=*".includes(c.char)).toBe(true);
    expect(c.activity).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// activityCell
// ---------------------------------------------------------------------------

describe("activityCell", () => {
  test("idle: returns null", () => {
    expect(activityCell(10_000, TRUECOLOR)).toBeNull();
    expect(activityCell(Infinity, TRUECOLOR)).toBeNull();
  });

  test("active + truecolor: returns coloured up-arrow", () => {
    const c = activityCell(0, TRUECOLOR);
    expect(c).not.toBeNull();
    expect(c!.char).toBe("\u2191");
    expect(c!.fg).toBeDefined();
    expect(c!.activity).toBe(true);
  });

  test("active + ASCII: returns plain +", () => {
    const c = activityCell(0, { truecolor: false, unicode: false, animate: true });
    expect(c!.char).toBe("+");
    expect(c!.fg).toBeUndefined();
  });

  test("color fades from BRAND_LIGHT toward BRAND_DARK over 4s window", () => {
    const fresh = activityCell(0, TRUECOLOR)!;
    const nearExpire = activityCell(3_900, TRUECOLOR)!;
    // Fresh should be closer to BRAND_LIGHT (green=255 max); aging toward BRAND_DARK (green=208).
    expect(fresh.fg!.g).toBeGreaterThan(nearExpire.fg!.g);
  });
});

// ---------------------------------------------------------------------------
// contextPressureCells
// ---------------------------------------------------------------------------

describe("contextPressureCells", () => {
  test("low pct (<60): green tier, no bold", () => {
    const cells = contextPressureCells(42, TRUECOLOR);
    expect(cells.map((c) => c.char).join("")).toBe("ctx: 42%");
    expect(cells.every((c) => !c.bold)).toBe(true);
    // The CTX_GREEN sentinel is { r: 0, g: 160, b: 120 }.
    expect(cells[0]!.fg).toEqual({ r: 0, g: 160, b: 120 });
  });

  test("yellow tier: 60–80%", () => {
    const cells = contextPressureCells(72, TRUECOLOR);
    expect(cells[0]!.fg).toEqual(CTX_YELLOW);
    expect(cells.every((c) => !c.bold)).toBe(true);
  });

  test("orange tier: 80–95%", () => {
    const cells = contextPressureCells(88, TRUECOLOR);
    expect(cells[0]!.fg).toEqual(CTX_ORANGE);
    expect(cells.every((c) => !c.bold)).toBe(true);
  });

  test("red + bold tier: >=95%", () => {
    const cells = contextPressureCells(97, TRUECOLOR);
    expect(cells[0]!.fg).toEqual(CTX_RED);
    expect(cells.every((c) => c.bold)).toBe(true);
  });

  test("no truecolor: plain cells with no fg", () => {
    const cells = contextPressureCells(97, PLAIN);
    expect(cells.map((c) => c.char).join("")).toBe("ctx: 97%");
    expect(cells.every((c) => !c.fg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cellsToAnsi
// ---------------------------------------------------------------------------

describe("cellsToAnsi", () => {
  test("empty array -> empty string", () => {
    expect(cellsToAnsi([])).toBe("");
  });

  test("cells without fg -> chars only", () => {
    const cells: Cell[] = [{ char: "a" }, { char: "b" }, { char: "c" }];
    expect(cellsToAnsi(cells)).toBe("abc");
  });

  test("single-color run emits one escape + one reset", () => {
    const fg = { r: 1, g: 2, b: 3 };
    const cells: Cell[] = [{ char: "x", fg }, { char: "y", fg }];
    const out = cellsToAnsi(cells);
    expect(out).toBe("\x1b[38;2;1;2;3mxy\x1b[0m");
  });

  test("two different colors produce two escape prefixes", () => {
    const cells: Cell[] = [
      { char: "x", fg: { r: 1, g: 2, b: 3 } },
      { char: "y", fg: { r: 4, g: 5, b: 6 } },
    ];
    const out = cellsToAnsi(cells);
    expect(out.startsWith("\x1b[38;2;1;2;3m")).toBe(true);
    expect(out).toContain("\x1b[0m\x1b[38;2;4;5;6m");
    expect(out.endsWith("\x1b[0m")).toBe(true);
  });

  test("bold emits 1m + reset", () => {
    const out = cellsToAnsi([{ char: "!", bold: true, fg: { r: 255, g: 0, b: 0 } }]);
    expect(out).toContain("\x1b[1m");
    expect(out).toContain("\x1b[38;2;255;0;0m!");
    expect(out.endsWith("\x1b[0m")).toBe(true);
  });

  test("non-styled cells between styled runs reset correctly", () => {
    const cells: Cell[] = [
      { char: "A", fg: { r: 1, g: 1, b: 1 } },
      { char: "B" },
      { char: "C", fg: { r: 2, g: 2, b: 2 } },
    ];
    const out = cellsToAnsi(cells);
    // Visible text survives with ANSI stripped.
    const visible = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(visible).toBe("ABC");
  });
});

// ---------------------------------------------------------------------------
// Golden frame snapshots — guard against accidental animation drift.
// ---------------------------------------------------------------------------

describe("golden frames", () => {
  test("frame=0, active: sparkline carries a full-brightness pulse head", () => {
    const cells = sparklineCells({
      values: [1, 3, 5, 8, 4, 2, 1],
      frame: 0,
      msSinceActive: 0,
      cap: TRUECOLOR,
    });
    expect(cells.length).toBe(7);
    // Exactly one cell is the 3-cell sweep's lead (full white). The trail
    // and dim-echo cells are partial blends — not pure white.
    const pulseHead = cells.find((c) =>
      c.activity && c.fg && c.fg.r === 255 && c.fg.g === 255 && c.fg.b === 255);
    expect(pulseHead).toBeDefined();
    // At least one non-activity cell exists (width > 3).
    expect(cells.some((c) => !c.activity)).toBe(true);
  });

  test("frame=100, idle: no activity cells anywhere", () => {
    const cells = sparklineCells({
      values: [1, 3, 5, 8, 4, 2, 1],
      frame: 100,
      msSinceActive: 20_000,
      cap: TRUECOLOR,
    });
    expect(cells.every((c) => !c.activity)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ANSI wrapper parity — cellsToAnsi(cells) equals the legacy output.
// ---------------------------------------------------------------------------

describe("ANSI parity with legacy renderers", () => {
  test("cellsToAnsi(sparklineCells(...)) round-trip keeps character content", () => {
    const input = {
      values: [2, 4, 6, 8, 6, 4, 2],
      frame: 7,
      msSinceActive: 1200,
      cap: TRUECOLOR,
    };
    const cells = sparklineCells(input);
    const out = cellsToAnsi(cells);
    const visible = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(visible).toBe(cells.map((c) => c.char).join(""));
  });
});
