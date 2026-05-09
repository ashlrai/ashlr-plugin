/**
 * _pricing.ts — single source of truth for $/MTok pricing across the plugin.
 *
 * Prior state: `servers/efficiency-server.ts` used $3/MTok (sonnet-4.5 input
 * only); `scripts/savings-dashboard.ts` used a hardcoded $5/MTok "blended"
 * rate; `scripts/session-greet.ts` had its own copy; `scripts/generate-badge.ts`
 * duplicated yet another PRICING map. Same token count produced three
 * different dollar values depending on which surface rendered it.
 *
 * This module centralizes the table. Both the efficiency-server renderer
 * and the dashboard import `pricing()` / `costFor()` here so a token count
 * maps to exactly one USD value regardless of surface.
 *
 * Model selection: read `ASHLR_PRICING_MODEL` env var. Default is
 * `sonnet-4.5` (Claude Code's default model). Unknown models fall back to
 * the default rather than throw — pricing must never break rendering.
 *
 * Numbers reflect input-token pricing per million tokens, as of 2026-04.
 * Savings reporting uses the input rate (we're measuring tokens *not sent*
 * into the model's context window, so the input price is the right
 * counterfactual).
 */
export interface ModelPrice {
  /** USD per 1M input tokens. */
  inUsd: number;
  /** USD per 1M output tokens. */
  outUsd: number;
}

/**
 * Canonical pricing table. Keys are stable short names; aliases map to the
 * same entry so callers can pass either `sonnet-4.5` or `claude-sonnet-4.5`.
 */
export const PRICING_TABLE: Record<string, ModelPrice> = {
  "sonnet-4.5":  { inUsd: 3.0,  outUsd: 15.0 },
  "sonnet-4.6":  { inUsd: 2.5,  outUsd: 12.5 },
  "opus-4":      { inUsd: 15.0, outUsd: 75.0 },
  "opus-4.7":    { inUsd: 18.0, outUsd: 90.0 },
  "haiku-4.5":   { inUsd: 0.8,  outUsd: 4.0  },
  // Local / offline providers — zero inference cost.
  "onnx":        { inUsd: 0,    outUsd: 0     },
  "local":       { inUsd: 0,    outUsd: 0     },
  "none":        { inUsd: 0,    outUsd: 0     },
};

/**
 * Default model for pricing when no override is specified. Updated to
 * sonnet-4.6 (the current Claude Code default as of 2026-04); sonnet-4.5
 * is retained in the table for back-compat with pinned configs.
 */
export const DEFAULT_PRICING_MODEL = "sonnet-4.6";

/**
 * Resolve the effective model name from the caller-supplied override,
 * `ASHLR_PRICING_MODEL`, or `CLAUDE_CODE_MODEL` (the env var Claude Code
 * exports to describe its active model). Returns the resolved name verbatim
 * so test harnesses can pin it; does NOT validate that the model exists in
 * the table — that check happens in `pricing()`.
 */

/** Track whether we've already warned about an unknown model this process. */
let _unknownModelWarned: string | null = null;

export function pricingModel(override?: string): string {
  if (override && override.trim().length > 0) return override.trim();
  const explicit = process.env.ASHLR_PRICING_MODEL;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  // Auto-detect from Claude Code's model env var. Strip the "claude-" prefix
  // if present so "claude-sonnet-4.6" resolves to "sonnet-4.6".
  const ccModel = process.env.CLAUDE_CODE_MODEL;
  if (ccModel && ccModel.trim().length > 0) {
    const raw = ccModel.trim();
    const normalized = raw.replace(/^claude-/, "");
    return normalized;
  }
  return DEFAULT_PRICING_MODEL;
}

/**
 * Return the price entry for a given model (or the resolved default).
 * Unknown models log a one-time warning to stderr and fall back to the
 * default — pricing lookups must never break a rendering path.
 */
export function pricing(model?: string): ModelPrice {
  const name = pricingModel(model);
  if (PRICING_TABLE[name]) return PRICING_TABLE[name]!;
  // Unknown model: warn once per process, then use default.
  if (_unknownModelWarned !== name) {
    _unknownModelWarned = name;
    process.stderr.write(`ashlr: unknown model "${name}", defaulting to ${DEFAULT_PRICING_MODEL} pricing\n`);
  }
  return PRICING_TABLE[DEFAULT_PRICING_MODEL]!;
}

/**
 * Compute the USD cost for a given input-token count at the model's input
 * rate. Always uses input pricing because savings reporting measures tokens
 * that would have been *sent into* the model (see module docstring).
 *
 * Negative / non-finite inputs clamp to 0 so downstream formatters never
 * see NaN.
 */
export function costFor(tokens: number, model?: string): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  const p = pricing(model);
  return (tokens * p.inUsd) / 1_000_000;
}

/**
 * Compute the USD cost of an LLM summarization call.
 *
 * Pricing per provider:
 *   anthropic — Haiku 4.5: $0.80/MTok in, $4.00/MTok out (user's own key)
 *   cloud     — ashlr hosted proxy: same Haiku 4.5 rates (Pro subscription covers it)
 *   onnx      — local inference: $0 (compute already paid)
 *   local     — LM Studio / Ollama: $0 (local inference)
 *   none      — no call made: $0
 *
 * Returns exact USD cost (may be fractional; callers format as needed).
 * Always finite; clamps bad inputs to 0.
 */
export function costForLLM(
  provider: "anthropic" | "cloud" | "onnx" | "local" | "none",
  inTokens: number,
  outTokens: number,
): number {
  if (provider !== "anthropic" && provider !== "cloud") return 0;
  const safeIn = Number.isFinite(inTokens) && inTokens > 0 ? inTokens : 0;
  const safeOut = Number.isFinite(outTokens) && outTokens > 0 ? outTokens : 0;
  // Haiku 4.5: $0.80/MTok in, $4.00/MTok out
  return (safeIn * 0.8 + safeOut * 4.0) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Summarizer-model detection
// ---------------------------------------------------------------------------

/**
 * Map from LLM provider name to the actual model used for summarization.
 * Used by getActiveSummarizerModel() to return a key resolvable in PRICING_TABLE.
 */
const PROVIDER_MODEL_MAP: Record<string, string> = {
  off:       "none",       // ASHLR_LLM_PROVIDER=off
  anthropic: "haiku-4.5",  // anthropic.ts hardcodes claude-haiku-4-5-20251001
  cloud:     "haiku-4.5",  // hosted proxy also uses Haiku
  onnx:      "onnx",       // local ONNX inference — $0
  local:     "local",      // LM Studio / Ollama — $0
  none:      "none",       // no summarization — $0
};

/**
 * Detect which summarizer model is actually active based on the
 * ASHLR_LLM_PROVIDER env var and ASHLR_LLM_URL heuristic.
 *
 * Returns a short model key resolvable in PRICING_TABLE (e.g. "haiku-4.5",
 * "onnx", "local"). Does NOT do a network availability check — purely env-based
 * so it stays synchronous and safe to call on hot paths.
 *
 * Order matches the selectProvider() logic in _llm-providers/index.ts:
 *   1. ASHLR_LLM_PROVIDER explicit override
 *   2. ASHLR_LLM_URL set → local
 *   3. ANTHROPIC_API_KEY or ~/.claude/.credentials.json present → anthropic
 *   4. Pro token present → cloud
 *   5. default → none (snipCompact fallback)
 */
export function getActiveSummarizerModel(homeOverride?: string): string {
  const pricingOverride = process.env["ASHLR_PRICING_MODEL"];
  // If the user explicitly set ASHLR_PRICING_MODEL, honor it as-is (power-user
  // override path — they want to peg to a specific price regardless of actual
  // summarizer).
  if (pricingOverride && pricingOverride.trim().length > 0) {
    return pricingOverride.trim();
  }

  const llmProvider = (process.env["ASHLR_LLM_PROVIDER"] ?? "auto").toLowerCase().trim();
  const mapped = PROVIDER_MODEL_MAP[llmProvider];
  if (mapped) return mapped;

  // "auto" — mirror selectProvider heuristic without awaiting.
  if (process.env["ASHLR_LLM_URL"]) return "local";

  // Anthropic key present (either env var or Claude Code credentials file)?
  if (process.env["ANTHROPIC_API_KEY"]) return "haiku-4.5";

  // Pro token present → cloud proxy (also Haiku).
  try {
    const { existsSync, statSync } = require("fs") as typeof import("fs");
    const { homedir } = require("os") as typeof import("os");
    const { join } = require("path") as typeof import("path");
    const home = homeOverride ?? process.env["HOME"] ?? homedir();
    const tokenPath = join(home, ".ashlr", "pro-token");
    if (existsSync(tokenPath) && statSync(tokenPath).size > 0) {
      return "haiku-4.5";
    }
  } catch {
    /* best-effort — fall through to none */
  }

  return "none";
}

/**
 * Return the input price (USD per million tokens) for the active summarizer
 * model. Suitable for correcting the `$ saved` display to reflect actual
 * inference costs rather than defaulting to Sonnet rates.
 *
 * Falls back to `pricing(override)` when a manual ASHLR_PRICING_MODEL override
 * is set — preserving backward compat for power users who want Sonnet
 * counterfactual pricing.
 */
export function getInputPriceForModel(model: string): number {
  const entry = PRICING_TABLE[model];
  if (entry) return entry.inUsd;
  // Unknown model: fall back to default pricing table entry.
  return PRICING_TABLE[DEFAULT_PRICING_MODEL]!.inUsd;
}

/**
 * costFor() using the detected summarizer model rather than the main LLM model.
 *
 * Use this for `$ saved` displays where the counterfactual is "what would it
 * have cost to send these tokens through the summarizer model" — not through
 * the user's primary model (Sonnet/Opus). The summarizer is typically Haiku,
 * which is ~3-4x cheaper than Sonnet.
 *
 * When ASHLR_PRICING_MODEL is explicitly set, honors it (backward compat).
 */
export function costForSummarizer(tokens: number, homeOverride?: string): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  const model = getActiveSummarizerModel(homeOverride);
  const pricePerM = getInputPriceForModel(model);
  return (tokens * pricePerM) / 1_000_000;
}
