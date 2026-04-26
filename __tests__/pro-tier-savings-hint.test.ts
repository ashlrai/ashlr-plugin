/**
 * pro-tier-savings-hint.test.ts
 *
 * Verifies that the Pro upsell hint appears in /ashlr-savings output when
 * lifetime savings >= $20, and is suppressed below that threshold and for
 * Pro/Team users.
 *
 * Tests both:
 *   1. The renderProUpsellHint helper directly.
 *   2. The renderSavings integration (hint wired through ExtraContext).
 */

import { describe, expect, test } from "bun:test";
import {
  renderProUpsellHint,
  PRO_UPSELL_THRESHOLD_DOLLARS,
} from "../scripts/savings-report-extras";
import { renderSavings } from "../servers/efficiency-server";
import type { LifetimeBucket, SessionBucket } from "../servers/_stats";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySession(): SessionBucket {
  return {
    startedAt: new Date().toISOString(),
    lastSavingAt: null,
    calls: 0,
    tokensSaved: 0,
    byTool: {},
  };
}

function emptyLifetime(): LifetimeBucket {
  return { calls: 0, tokensSaved: 0, byTool: {}, byDay: {} };
}

// At sonnet-4.6 pricing ($2.50/MTok input), $20 ≈ 8 000 000 tokens.
// We use a concrete token count that results in > $20 at any supported model.
// Sonnet-4.5 is $3.00/MTok → 8 000 000 tok = $24. Safe margin.
const TOKENS_ABOVE_THRESHOLD = 8_000_000; // → ≥ $20 at any model in the table
const TOKENS_BELOW_THRESHOLD = 1_000_000; // → ≤ $3.00 at any model

// ---------------------------------------------------------------------------
// renderProUpsellHint — unit tests
// ---------------------------------------------------------------------------

describe("renderProUpsellHint", () => {
  test("constant: threshold is $20", () => {
    expect(PRO_UPSELL_THRESHOLD_DOLLARS).toBe(20);
  });

  test("returns empty string when proUser=true, regardless of savings", () => {
    expect(renderProUpsellHint(100, true)).toBe("");
    expect(renderProUpsellHint(0, true)).toBe("");
  });

  test("returns empty string when lifetimeDollarsSaved < threshold", () => {
    expect(renderProUpsellHint(0, false)).toBe("");
    expect(renderProUpsellHint(19.99, false)).toBe("");
    expect(renderProUpsellHint(PRO_UPSELL_THRESHOLD_DOLLARS - 0.01, false)).toBe("");
  });

  test("returns hint at exactly the threshold", () => {
    const hint = renderProUpsellHint(PRO_UPSELL_THRESHOLD_DOLLARS, false);
    expect(hint.length).toBeGreaterThan(0);
  });

  test("returns hint when savings > threshold and user is on Free", () => {
    const hint = renderProUpsellHint(25, false);
    expect(hint).toContain("/ashlr-upgrade");
    expect(hint).toContain("Pro");
  });

  test("hint mentions cross-machine sync or cloud genome", () => {
    const hint = renderProUpsellHint(25, false);
    expect(hint.toLowerCase()).toMatch(/cross-machine|cloud|sync/);
  });

  test("hint is a single line (no newlines)", () => {
    const hint = renderProUpsellHint(25, false);
    expect(hint).not.toContain("\n");
  });

  test("hint fits within 120 chars", () => {
    const hint = renderProUpsellHint(25, false);
    expect(hint.length).toBeLessThanOrEqual(120);
  });

  test("optional lifetimeDollarsFmt is used when provided", () => {
    const hint = renderProUpsellHint(25, false, "$25.42");
    expect(hint).toContain("$25.42");
  });
});

// ---------------------------------------------------------------------------
// renderSavings integration — hint visible/hidden based on ExtraContext
// ---------------------------------------------------------------------------

describe("renderSavings · Pro upsell hint integration", () => {
  test("hint appears when lifetime savings >= $20 and user is on Free", () => {
    const lifetime = emptyLifetime();
    lifetime.tokensSaved = TOKENS_ABOVE_THRESHOLD;
    const out = renderSavings(emptySession(), lifetime, {
      lifetimeDollarsSaved: 25,
      proUser: false,
    });
    expect(out).toContain("/ashlr-upgrade");
    expect(out).toContain("Pro");
  });

  test("hint absent when lifetime savings < $20", () => {
    const lifetime = emptyLifetime();
    lifetime.tokensSaved = TOKENS_BELOW_THRESHOLD;
    const out = renderSavings(emptySession(), lifetime, {
      lifetimeDollarsSaved: 3,
      proUser: false,
    });
    expect(out).not.toContain("/ashlr-upgrade");
  });

  test("hint absent when proUser=true even with high savings", () => {
    const lifetime = emptyLifetime();
    lifetime.tokensSaved = TOKENS_ABOVE_THRESHOLD;
    const out = renderSavings(emptySession(), lifetime, {
      lifetimeDollarsSaved: 50,
      proUser: true,
    });
    expect(out).not.toContain("/ashlr-upgrade");
  });

  test("hint absent when extra is undefined (no threshold met)", () => {
    const out = renderSavings(emptySession(), emptyLifetime());
    expect(out).not.toContain("/ashlr-upgrade");
  });

  test("hint absent when lifetimeDollarsSaved not provided in extra", () => {
    const out = renderSavings(emptySession(), emptyLifetime(), {
      proUser: false,
    });
    expect(out).not.toContain("/ashlr-upgrade");
  });
});
