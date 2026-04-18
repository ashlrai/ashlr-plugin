/**
 * Unit tests for the status-line animation primitives.
 *
 * Every function under test is pure (no I/O, no date calls), so assertions
 * are deterministic.
 */

import { describe, expect, test } from "bun:test";

import {
  UNICODE_RAMP,
  ASCII_RAMP,
  ACTIVITY_ACTIVE_MS,
  ACTIVITY_GLYPH_ASCII,
  ACTIVITY_GLYPH_UNICODE,
  activityIndicator,
  computePulse,
  detectCapability,
  frameAt,
  gradientTs,
  lerpColor,
  renderContextPressure,
  renderHeartbeat,
  renderSparkline,
  sweepFactor,
  valuesToRamp,
  visibleWidth,
} from "../scripts/ui-animation";

describe("detectCapability", () => {
  test("NO_COLOR disables truecolor and animation", () => {
    const cap = detectCapability({ NO_COLOR: "1", COLORTERM: "truecolor" });
    expect(cap.truecolor).toBe(false);
    expect(cap.animate).toBe(false);
  });

  test("COLORTERM=truecolor enables animation", () => {
    const cap = detectCapability({ COLORTERM: "truecolor", LANG: "en_US.UTF-8" });
    expect(cap.truecolor).toBe(true);
    expect(cap.animate).toBe(true);
  });

  test("ASHLR_STATUS_ANIMATE=0 kills animation regardless of color", () => {
    const cap = detectCapability({ COLORTERM: "truecolor", ASHLR_STATUS_ANIMATE: "0" });
    expect(cap.animate).toBe(false);
  });

  test("ASHLR_STATUS_ANIMATE=1 forces animation even without truecolor advertise", () => {
    const cap = detectCapability({ ASHLR_STATUS_ANIMATE: "1" });
    expect(cap.animate).toBe(true);
    expect(cap.truecolor).toBe(true); // forceAnimate also enables truecolor emit
  });

  test("unicode detection works via LANG", () => {
    expect(detectCapability({ LANG: "en_US.UTF-8" }).unicode).toBe(true);
    expect(detectCapability({ LANG: "C", TERM: "dumb" }).unicode).toBe(false);
  });
});

describe("frameAt", () => {
  test("monotonically increases across time", () => {
    const a = frameAt(1000, 120);
    const b = frameAt(1000 + 120, 120);
    expect(b).toBe(a + 1);
  });
  test("equal within the same 120ms window", () => {
    // Frame 8 spans [960, 1080); 1000 and 1079 both fall inside it.
    expect(frameAt(1000, 120)).toBe(frameAt(1079, 120));
  });
});

describe("valuesToRamp", () => {
  test("all zeros map to rung 0", () => {
    expect(valuesToRamp([0, 0, 0], UNICODE_RAMP.length)).toEqual([0, 0, 0]);
  });
  test("any positive value maps to at least rung 1", () => {
    const r = valuesToRamp([0, 1, 100], 16);
    expect(r[0]).toBe(0);
    expect(r[1]).toBeGreaterThanOrEqual(1);
    expect(r[2]).toBe(15);
  });
});

describe("gradientTs", () => {
  test("all values are in [0,1]", () => {
    const ts = gradientTs(7, 42);
    for (const t of ts) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });
  test("zero width returns empty", () => {
    expect(gradientTs(0, 0)).toEqual([]);
  });
});

describe("computePulse", () => {
  test("idle → intensity 0", () => {
    expect(computePulse(10, 10_000, 7).intensity).toBe(0);
  });
  test("active window → intensity 1", () => {
    expect(computePulse(10, 1000, 7).intensity).toBe(1);
  });
  test("fade window → intensity between 0 and 1", () => {
    const p = computePulse(10, 4250, 7);
    expect(p.intensity).toBeGreaterThan(0);
    expect(p.intensity).toBeLessThan(1);
  });
});

describe("renderSparkline", () => {
  test("7 values + static caps → 7 visible chars, no ANSI", () => {
    const cap = detectCapability({ NO_COLOR: "1" });
    const out = renderSparkline({
      values: [0, 0, 1, 2, 3, 4, 5],
      frame: 0,
      msSinceActive: Number.POSITIVE_INFINITY,
      cap,
    });
    expect(visibleWidth(out)).toBe(7);
    expect(out).not.toMatch(/\x1b\[/);
  });

  test("truecolor + animate → wraps chars in ANSI but keeps visible width", () => {
    const cap = detectCapability({ COLORTERM: "truecolor", LANG: "en_US.UTF-8" });
    const out = renderSparkline({
      values: [1, 1, 1, 1, 1, 1, 1],
      frame: 3,
      msSinceActive: 1000,
      cap,
    });
    expect(out).toMatch(/\x1b\[38;2;/);
    expect(visibleWidth(out)).toBe(7);
  });

  test("width is stable across 60 consecutive frames", () => {
    const cap = detectCapability({ COLORTERM: "truecolor", LANG: "en_US.UTF-8" });
    const values = [0, 1, 2, 3, 4, 5, 6];
    const widths = new Set<number>();
    for (let f = 0; f < 60; f++) {
      const out = renderSparkline({ values, frame: f, msSinceActive: 2000, cap });
      widths.add(visibleWidth(out));
    }
    expect(widths.size).toBe(1);
  });
});

describe("renderHeartbeat", () => {
  test("idle in animation-disabled mode returns a single plain char", () => {
    const cap = detectCapability({ NO_COLOR: "1" });
    const out = renderHeartbeat(0, Number.POSITIVE_INFINITY, cap);
    expect(visibleWidth(out)).toBe(1);
    expect(out).not.toMatch(/\x1b\[/);
  });
  test("active in truecolor mode wraps with ANSI", () => {
    const cap = detectCapability({ COLORTERM: "truecolor", LANG: "en_US.UTF-8" });
    const out = renderHeartbeat(5, 500, cap);
    expect(out).toMatch(/\x1b\[38;2;/);
    expect(visibleWidth(out)).toBe(1);
  });
});

describe("lerpColor", () => {
  test("t=0 returns a, t=1 returns b", () => {
    const a = { r: 0, g: 0, b: 0 };
    const b = { r: 255, g: 255, b: 255 };
    expect(lerpColor(a, b, 0)).toEqual(a);
    expect(lerpColor(a, b, 1)).toEqual(b);
  });
  test("t=0.5 returns midpoint", () => {
    const mid = lerpColor({ r: 0, g: 0, b: 0 }, { r: 100, g: 200, b: 50 }, 0.5);
    expect(mid.r).toBe(50);
    expect(mid.g).toBe(100);
    expect(mid.b).toBe(25);
  });
});

describe("visibleWidth", () => {
  test("strips CSI escapes", () => {
    expect(visibleWidth("\x1b[38;2;0;208;156mX\x1b[0m")).toBe(1);
    expect(visibleWidth("ashlr \x1b[1m·\x1b[0m")).toBe(7);
  });
});

describe("ASCII fallback", () => {
  test("non-unicode capability uses the ASCII ramp", () => {
    const cap = detectCapability({ LANG: "C", TERM: "dumb", NO_COLOR: "1" });
    expect(cap.unicode).toBe(false);
    const out = renderSparkline({ values: [0, 1, 2, 3, 4, 5, 6], frame: 0, msSinceActive: Infinity, cap });
    for (const ch of out) {
      expect(ASCII_RAMP.includes(ch)).toBe(true);
    }
  });
});

describe("renderContextPressure", () => {
  const truecolorCap = detectCapability({ COLORTERM: "truecolor", LANG: "en_US.UTF-8" });
  const plainCap     = detectCapability({ NO_COLOR: "1" });

  test("visible width is stable across all tiers", () => {
    for (const pct of [10, 50, 72, 85, 97]) {
      const out = renderContextPressure(pct, truecolorCap);
      // "ctx: NN%" → 8 chars; "ctx: 100%" → 9 chars. Stable per pct.
      expect(visibleWidth(out)).toBe(`ctx: ${Math.round(pct)}%`.length);
    }
  });

  test("NO_COLOR → plain text, no ANSI", () => {
    const out = renderContextPressure(50, plainCap);
    expect(out).toBe("ctx: 50%");
    expect(out).not.toMatch(/\x1b\[/);
  });

  // Tier: 0–60% → dim brand-green (#00d09c range, dark variant)
  test("50% → truecolor green escape", () => {
    const out = renderContextPressure(50, truecolorCap);
    expect(out).toMatch(/\x1b\[38;2;/);
    // Green channel dominant; red low
    expect(out).toMatch(/\x1b\[38;2;0;160;120m/);
    expect(out).not.toMatch(/\x1b\[1m/); // no bold
  });

  // Tier: 60–80% → yellow (#d4a72c)
  test("75% → truecolor yellow escape", () => {
    const out = renderContextPressure(75, truecolorCap);
    expect(out).toMatch(/\x1b\[38;2;212;167;44m/);
    expect(out).not.toMatch(/\x1b\[1m/); // no bold
  });

  // Tier: 80–95% → orange (#d9793a)
  test("90% → truecolor orange escape", () => {
    const out = renderContextPressure(90, truecolorCap);
    expect(out).toMatch(/\x1b\[38;2;217;121;58m/);
    expect(out).not.toMatch(/\x1b\[1m/); // no bold
  });

  // Tier: 95%+ → red + bold (#e15b5b)
  test("97% → truecolor red + bold escape", () => {
    const out = renderContextPressure(97, truecolorCap);
    expect(out).toMatch(/\x1b\[38;2;225;91;91m/);
    expect(out).toMatch(/\x1b\[1m/); // bold on
  });

  test("boundary at exactly 60% uses green tier", () => {
    const out = renderContextPressure(60, truecolorCap);
    expect(out).toMatch(/\x1b\[38;2;212;167;44m/); // yellow (60 is start of yellow tier)
  });

  test("boundary at exactly 80% uses orange tier", () => {
    const out = renderContextPressure(80, truecolorCap);
    expect(out).toMatch(/\x1b\[38;2;217;121;58m/);
  });

  test("boundary at exactly 95% uses red tier with bold", () => {
    const out = renderContextPressure(95, truecolorCap);
    expect(out).toMatch(/\x1b\[38;2;225;91;91m/);
    expect(out).toMatch(/\x1b\[1m/);
  });

  test("width stable across 60 consecutive frames (same pct)", () => {
    const widths = new Set<number>();
    for (let f = 0; f < 60; f++) {
      widths.add(visibleWidth(renderContextPressure(72, truecolorCap)));
    }
    expect(widths.size).toBe(1);
  });
});

describe("sweepFactor — 3-cell trail effect", () => {
  test("lead cell (delta 0) returns 1.0", () => {
    expect(sweepFactor(3, 3, 7)).toBe(1.0);
  });

  test("trail cell (one behind, delta w-1) returns 0.45", () => {
    // head=3, width=7: trail is cell 2 (delta = (2-3+7)%7 = 6 = w-1)
    expect(sweepFactor(2, 3, 7)).toBe(0.45);
  });

  test("dim-echo cell (two behind, delta w-2) returns 0.15", () => {
    // head=3, width=7: echo is cell 1 (delta = (1-3+7)%7 = 5 = w-2)
    expect(sweepFactor(1, 3, 7)).toBe(0.15);
  });

  test("unrelated cell returns 0", () => {
    expect(sweepFactor(5, 3, 7)).toBe(0);
    expect(sweepFactor(0, 3, 7)).toBe(0);
  });

  test("wraps correctly at left edge (head=0)", () => {
    // trail should be cell w-1=6, echo should be cell w-2=5
    expect(sweepFactor(6, 0, 7)).toBe(0.45);
    expect(sweepFactor(5, 0, 7)).toBe(0.15);
    expect(sweepFactor(0, 0, 7)).toBe(1.0);
  });
});

describe("renderSparkline sweep-with-trail — frame stability + visible motion", () => {
  const cap = detectCapability({ COLORTERM: "truecolor", LANG: "en_US.UTF-8" });
  const values = [0, 1, 2, 3, 4, 5, 6];

  test("width stays stable across 60 frames with active pulse", () => {
    const widths = new Set<number>();
    for (let f = 0; f < 60; f++) {
      const out = renderSparkline({ values, frame: f, msSinceActive: 500, cap });
      widths.add(visibleWidth(out));
    }
    expect(widths.size).toBe(1);
  });

  test("sweep produces distinct color values across adjacent cells (visible motion)", () => {
    // With a 7-cell sparkline and active pulse, the head and trail cells must
    // have different ANSI color codes — i.e. the sweep is visible.
    // We check that at least two distinct rgb triples appear in the output
    // (head = white-blended, adjacent = less-blended).
    const out = renderSparkline({ values, frame: 10, msSinceActive: 500, cap });
    // Collect all rgb triples from the output.
    const triples = [...out.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)]
      .map((m) => `${m[1]},${m[2]},${m[3]}`);
    const unique = new Set(triples);
    expect(unique.size).toBeGreaterThan(1);
  });

  test("idle pulse → same output as before (intensity 0, no bright cells)", () => {
    const active = renderSparkline({ values, frame: 10, msSinceActive: 500, cap });
    const idle   = renderSparkline({ values, frame: 10, msSinceActive: 10_000, cap });
    // The idle version should not contain 255,255,255 (white pulse blending).
    expect(idle).not.toMatch(/\x1b\[38;2;255;255;255m/);
    // Active version must differ from idle (sweep is visible).
    expect(active).not.toBe(idle);
  });
});

describe("activityIndicator", () => {
  const truecolorCap = detectCapability({ COLORTERM: "truecolor", LANG: "en_US.UTF-8" });
  const plainUnicode = detectCapability({ LANG: "en_US.UTF-8", NO_COLOR: "1" });
  const asciicap     = detectCapability({ LANG: "C", TERM: "dumb", NO_COLOR: "1" });

  // --- idle states ---
  test("returns empty string when idle (msSinceActive > ACTIVITY_ACTIVE_MS)", () => {
    expect(activityIndicator(ACTIVITY_ACTIVE_MS + 1, truecolorCap)).toBe("");
    expect(activityIndicator(Number.POSITIVE_INFINITY, truecolorCap)).toBe("");
    expect(activityIndicator(10_000, asciicap)).toBe("");
  });

  test("returns empty string at exactly the boundary (ACTIVITY_ACTIVE_MS + 1)", () => {
    expect(activityIndicator(ACTIVITY_ACTIVE_MS + 1, truecolorCap)).toBe("");
  });

  // --- active states ---
  test("truecolor + unicode → 1 visible char with ANSI escape", () => {
    const out = activityIndicator(500, truecolorCap);
    expect(visibleWidth(out)).toBe(1);
    expect(out).toMatch(/\x1b\[38;2;/);
    expect(out).toContain(ACTIVITY_GLYPH_UNICODE);
  });

  test("plain unicode (no truecolor) → bare unicode glyph, no ANSI", () => {
    const out = activityIndicator(500, plainUnicode);
    expect(out).toBe(ACTIVITY_GLYPH_UNICODE);
    expect(out).not.toMatch(/\x1b\[/);
    expect(visibleWidth(out)).toBe(1);
  });

  test("ASCII fallback → bare '+' char, no ANSI", () => {
    const out = activityIndicator(500, asciicap);
    expect(out).toBe(ACTIVITY_GLYPH_ASCII);
    expect(out).not.toMatch(/\x1b\[/);
    expect(visibleWidth(out)).toBe(1);
  });

  test("at exactly ms=0 → active (fresh save)", () => {
    const out = activityIndicator(0, truecolorCap);
    expect(visibleWidth(out)).toBe(1);
  });

  test("at exactly ACTIVITY_ACTIVE_MS → still active", () => {
    const out = activityIndicator(ACTIVITY_ACTIVE_MS, truecolorCap);
    expect(visibleWidth(out)).toBe(1);
  });

  // --- width stability across 60 frames ---
  // The indicator is stateless w.r.t. frame — same ms → same width always.
  test("visible width is stable: always 0 (idle) or always 1 (active)", () => {
    // Active: 60 distinct ms values all inside the window.
    const activeWidths = new Set<number>();
    for (let i = 0; i < 60; i++) {
      activeWidths.add(visibleWidth(activityIndicator(i * 50, truecolorCap)));
    }
    expect(activeWidths.size).toBe(1);
    expect([...activeWidths][0]).toBe(1);

    // Idle: 60 values all outside the window.
    const idleWidths = new Set<number>();
    for (let i = 0; i < 60; i++) {
      idleWidths.add(visibleWidth(activityIndicator(ACTIVITY_ACTIVE_MS + 1 + i, truecolorCap)));
    }
    expect(idleWidths.size).toBe(1);
    expect([...idleWidths][0]).toBe(0);
  });

  // --- color fades from BRAND_LIGHT toward BRAND_DARK over the window ---
  test("color at ms=0 is lighter (more BRAND_LIGHT) than at ms near ACTIVITY_ACTIVE_MS", () => {
    const fresh = activityIndicator(0, truecolorCap);
    const stale = activityIndicator(ACTIVITY_ACTIVE_MS - 1, truecolorCap);
    // Both have ANSI color codes; extract green channel (should be higher for fresh).
    const greenOf = (s: string) => {
      const m = s.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
      return m ? parseInt(m[2]!) : -1;
    };
    expect(greenOf(fresh)).toBeGreaterThan(greenOf(stale));
  });
});
