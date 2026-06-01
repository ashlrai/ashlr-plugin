/**
 * Tests for bootstrapCI in scripts/run-benchmark.ts
 *
 * Covers:
 *   1. Empty array → { lo: 1, hi: 1 }
 *   2. Single element → lo === hi === element
 *   3. Known array → lo <= mean <= hi, lo <= hi
 *   4. Deterministic — same input → same output every call
 *   5. Sane bounds on a realistic ratio array (0.2–0.5 range)
 */

import { describe, expect, test } from "bun:test";
import { bootstrapCI } from "../scripts/run-benchmark.ts";

describe("bootstrapCI", () => {
  test("empty array returns {lo:1, hi:1}", () => {
    const ci = bootstrapCI([]);
    expect(ci.lo).toBe(1);
    expect(ci.hi).toBe(1);
  });

  test("single element: lo === hi === element", () => {
    const ci = bootstrapCI([0.42]);
    expect(ci.lo).toBe(0.42);
    expect(ci.hi).toBe(0.42);
  });

  test("lo <= hi always", () => {
    const ratios = [0.3, 0.5, 0.4, 0.35, 0.45, 0.38, 0.52];
    const ci = bootstrapCI(ratios);
    expect(ci.lo).toBeLessThanOrEqual(ci.hi);
  });

  test("CI contains the sample mean", () => {
    const ratios = [0.3, 0.5, 0.4, 0.35, 0.45, 0.38, 0.52];
    const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
    const ci = bootstrapCI(ratios);
    expect(ci.lo).toBeLessThanOrEqual(mean + 1e-9);
    expect(ci.hi).toBeGreaterThanOrEqual(mean - 1e-9);
  });

  test("deterministic — identical output for same input", () => {
    const ratios = [0.2, 0.3, 0.25, 0.4, 0.35, 0.22, 0.28, 0.33];
    const a = bootstrapCI(ratios, 500);
    const b = bootstrapCI(ratios, 500);
    expect(a.lo).toBe(b.lo);
    expect(a.hi).toBe(b.hi);
  });

  test("sane bounds on realistic read ratios (0.2–0.5)", () => {
    // Typical ashlr__read ratios are ~0.2–0.4 (70–80% savings)
    const ratios = [0.18, 0.25, 0.32, 0.28, 0.22, 0.35, 0.20, 0.30, 0.19, 0.27];
    const ci = bootstrapCI(ratios, 1000);
    // lo should be comfortably below 0.35
    expect(ci.lo).toBeLessThan(0.35);
    // hi should be comfortably below 0.5
    expect(ci.hi).toBeLessThan(0.50);
    // Both should be positive
    expect(ci.lo).toBeGreaterThan(0);
    expect(ci.hi).toBeGreaterThan(0);
  });

  test("all-equal array: lo === hi === that value", () => {
    const ratios = [0.3, 0.3, 0.3, 0.3, 0.3];
    const ci = bootstrapCI(ratios, 200);
    expect(Math.abs(ci.lo - 0.3)).toBeLessThan(1e-6);
    expect(Math.abs(ci.hi - 0.3)).toBeLessThan(1e-6);
  });
});
