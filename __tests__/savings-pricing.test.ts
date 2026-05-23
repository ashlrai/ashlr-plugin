/**
 * savings-pricing.test.ts — Track 5.3 pricing-model accuracy.
 *
 * Verifies:
 *   1. getActiveSummarizerModel detects Haiku when ANTHROPIC_API_KEY is set
 *   2. getActiveSummarizerModel detects local when ASHLR_LLM_URL is set
 *   3. getActiveSummarizerModel returns "none" when no provider is configured
 *   4. getActiveSummarizerModel respects explicit ASHLR_LLM_PROVIDER overrides
 *   5. costForSummarizer returns correct $ for Haiku ($0.80/MTok input)
 *   6. costForSummarizer returns correct $ for Sonnet ($2.50/MTok input — sonnet-4.6)
 *   7. ASHLR_PRICING_MODEL env override still works (backward compat)
 *   8. Local ONNX/none provider returns $0 (zero cost)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  getActiveSummarizerModel,
  getInputPriceForModel,
  costForSummarizer,
  PRICING_TABLE,
} from "../servers/_pricing";

// ---------------------------------------------------------------------------
// Env isolation helpers
// ---------------------------------------------------------------------------

type EnvSnapshot = Record<string, string | undefined>;

const WATCHED_VARS = [
  "ASHLR_LLM_PROVIDER",
  "ASHLR_LLM_URL",
  "ANTHROPIC_API_KEY",
  "ASHLR_PRICING_MODEL",
];

let snapshot: EnvSnapshot = {};

beforeEach(() => {
  snapshot = {};
  for (const v of WATCHED_VARS) {
    snapshot[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of WATCHED_VARS) {
    if (snapshot[v] === undefined) {
      delete process.env[v];
    } else {
      process.env[v] = snapshot[v];
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Model detection
// ---------------------------------------------------------------------------

describe("getActiveSummarizerModel", () => {
  it("returns haiku-4.5 when ANTHROPIC_API_KEY is set", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    expect(getActiveSummarizerModel()).toBe("haiku-4.5");
  });

  it("returns local when ASHLR_LLM_URL is set", () => {
    process.env["ASHLR_LLM_URL"] = "http://localhost:1234/v1";
    expect(getActiveSummarizerModel()).toBe("local");
  });

  it("returns none when no provider is configured", () => {
    // No env vars set — falls through to none.
    expect(getActiveSummarizerModel("/tmp/no-such-home-ashlr-test")).toBe("none");
  });

  it("returns haiku-4.5 for ASHLR_LLM_PROVIDER=anthropic", () => {
    process.env["ASHLR_LLM_PROVIDER"] = "anthropic";
    expect(getActiveSummarizerModel()).toBe("haiku-4.5");
  });

  it("returns haiku-4.5 for ASHLR_LLM_PROVIDER=cloud", () => {
    process.env["ASHLR_LLM_PROVIDER"] = "cloud";
    expect(getActiveSummarizerModel()).toBe("haiku-4.5");
  });

  it("returns onnx for ASHLR_LLM_PROVIDER=onnx", () => {
    process.env["ASHLR_LLM_PROVIDER"] = "onnx";
    expect(getActiveSummarizerModel()).toBe("onnx");
  });

  it("returns none for ASHLR_LLM_PROVIDER=off", () => {
    process.env["ASHLR_LLM_PROVIDER"] = "off";
    expect(getActiveSummarizerModel()).toBe("none");
  });

  it("ASHLR_PRICING_MODEL override takes priority and passes through verbatim", () => {
    process.env["ASHLR_PRICING_MODEL"] = "sonnet-4.6";
    process.env["ANTHROPIC_API_KEY"] = "sk-ignored";
    expect(getActiveSummarizerModel()).toBe("sonnet-4.6");
  });
});

// ---------------------------------------------------------------------------
// 2. Price lookup
// ---------------------------------------------------------------------------

describe("getInputPriceForModel", () => {
  it("returns $0.80/MTok for haiku-4.5", () => {
    expect(getInputPriceForModel("haiku-4.5")).toBeCloseTo(0.8);
  });

  it("returns $2.50/MTok for sonnet-4.6", () => {
    expect(getInputPriceForModel("sonnet-4.6")).toBeCloseTo(2.5);
  });

  it("returns $0 for onnx", () => {
    expect(getInputPriceForModel("onnx")).toBe(0);
  });

  it("returns $0 for local", () => {
    expect(getInputPriceForModel("local")).toBe(0);
  });

  it("returns $0 for none", () => {
    expect(getInputPriceForModel("none")).toBe(0);
  });

  it("falls back to default for unknown model names", () => {
    const defaultEntry = PRICING_TABLE["sonnet-4.6"]!;
    expect(getInputPriceForModel("totally-unknown-model-xyz")).toBe(defaultEntry.inUsd);
  });
});

// ---------------------------------------------------------------------------
// 3. costForSummarizer math
// ---------------------------------------------------------------------------

describe("costForSummarizer", () => {
  it("returns correct $ for 250M tokens at Haiku rates ($0.80/MTok)", () => {
    process.env["ASHLR_LLM_PROVIDER"] = "anthropic";
    // 250_000_000 tokens × $0.80 / 1_000_000 = $200
    const cost = costForSummarizer(250_000_000);
    expect(cost).toBeCloseTo(200.0, 2);
  });

  it("returns correct $ for 1M tokens at Haiku rates", () => {
    process.env["ASHLR_LLM_PROVIDER"] = "anthropic";
    // 1_000_000 × $0.80 / 1_000_000 = $0.80
    expect(costForSummarizer(1_000_000)).toBeCloseTo(0.8, 4);
  });

  it("returns correct $ for 1M tokens at Sonnet-4.6 rates when pinned", () => {
    process.env["ASHLR_PRICING_MODEL"] = "sonnet-4.6";
    // $2.50/MTok
    expect(costForSummarizer(1_000_000)).toBeCloseTo(2.5, 4);
  });

  it("falls back to main-model pricing for onnx provider (no explicit pricing override)", () => {
    // Pre-v1.31 this returned $0 (Haiku rate × 0). The user-facing bug was
    // a "≈$0.00" status line for first-touch users. Now we fall back to the
    // main-model counterfactual: those tokens would have hit the main model.
    process.env["ASHLR_LLM_PROVIDER"] = "onnx";
    // 100M tokens × $2.50 (sonnet-4.6 default) / 1M = $250
    expect(costForSummarizer(100_000_000)).toBeCloseTo(250.0, 2);
  });

  it("falls back to main-model pricing for none provider (no explicit pricing override)", () => {
    process.env["ASHLR_LLM_PROVIDER"] = "off";
    // 100M tokens × $2.50 (sonnet-4.6 default) / 1M = $250
    expect(costForSummarizer(100_000_000)).toBeCloseTo(250.0, 2);
  });

  it("clamps negative token counts to $0", () => {
    process.env["ASHLR_LLM_PROVIDER"] = "anthropic";
    expect(costForSummarizer(-1000)).toBe(0);
  });

  it("clamps zero tokens to $0", () => {
    expect(costForSummarizer(0)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // v1.31 fix — $0 savings display bug
  //   When the auto-resolver lands on a zero-priced model ("none", "onnx",
  //   "local") AND ASHLR_PRICING_MODEL is NOT explicitly set, fall back to
  //   main-model pricing. Showing $0 to free-tier first-touch users was the
  //   bug; the counterfactual is the main model (no summarizer is wired up).
  // ---------------------------------------------------------------------------

  it("(v1.31) auto-resolves to \"none\" with no env vars set — falls back to main-model pricing", () => {
    // No ANTHROPIC_API_KEY, no ASHLR_LLM_URL, no ASHLR_LLM_PROVIDER, no
    // ASHLR_PRICING_MODEL override. getActiveSummarizerModel returns "none".
    // Expectation: costForSummarizer == costFor (sonnet-4.6 default = $2.50/MTok).
    const cost = costForSummarizer(1_000_000, "/tmp/no-such-home-ashlr-v131");
    expect(cost).toBeCloseTo(2.5, 4);
  });

  it("(v1.31) ANTHROPIC_API_KEY set → still resolves to haiku-4.5 ($0.80/MTok)", () => {
    // Regression guard: the v1.31 fallback must NOT clobber the existing
    // Haiku path — when a real summarizer is wired up, use its rate.
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    expect(costForSummarizer(1_000_000)).toBeCloseTo(0.8, 4);
  });

  it("(v1.31) explicit ASHLR_PRICING_MODEL=none honors override and returns $0", () => {
    // Power-user override: if the user explicitly pegs to a $0-priced model,
    // respect their choice. We only fall back to main-model pricing when the
    // zero price came from auto-resolution.
    process.env["ASHLR_PRICING_MODEL"] = "none";
    expect(costForSummarizer(1_000_000, "/tmp/no-such-home-ashlr-v131")).toBe(0);
  });

  it("(v1.31) ASHLR_LLM_PROVIDER=onnx with no pricing override → main-model pricing", () => {
    // Auto-resolves to "onnx" ($0). No ASHLR_PRICING_MODEL set. Should fall
    // back to costFor (sonnet-4.6 default).
    process.env["ASHLR_LLM_PROVIDER"] = "onnx";
    // 1M × $2.50 / 1M = $2.50
    expect(costForSummarizer(1_000_000)).toBeCloseTo(2.5, 4);
  });
});

// ---------------------------------------------------------------------------
// 4. Delta vs old Sonnet-default display (illustrative)
// ---------------------------------------------------------------------------

describe("Haiku vs Sonnet savings delta", () => {
  it("250M-token session: Haiku shows ~1/3 of old Sonnet display", () => {
    const tokens = 250_000_000;
    const oldSonnetRate = 3.0;   // $3/MTok — the prior hardcoded rate
    const haikuRate     = 0.8;   // $0.80/MTok — Haiku actual

    const oldDisplay = (tokens * oldSonnetRate) / 1_000_000; // $750
    const newDisplay = (tokens * haikuRate)     / 1_000_000; // $200

    // New display is roughly 3.75x less than old display.
    expect(oldDisplay / newDisplay).toBeCloseTo(3.75, 1);
    expect(newDisplay).toBeCloseTo(200, 0);
  });
});
