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
  "sonnet-4.5": { inUsd: 3.0, outUsd: 15.0 },
  "opus-4":     { inUsd: 15.0, outUsd: 75.0 },
  "haiku-4.5":  { inUsd: 0.8, outUsd: 4.0 },
};

export const DEFAULT_PRICING_MODEL = "sonnet-4.5";

/**
 * Resolve the effective model name from `ASHLR_PRICING_MODEL` or the
 * caller-supplied override. Returns the env-var value verbatim (after a
 * trim) so test harnesses can pin it; does NOT validate that the model
 * exists in the table — that check happens in `pricing()`.
 */
export function pricingModel(override?: string): string {
  if (override && override.trim().length > 0) return override.trim();
  const env = process.env.ASHLR_PRICING_MODEL;
  if (env && env.trim().length > 0) return env.trim();
  return DEFAULT_PRICING_MODEL;
}

/**
 * Return the price entry for a given model (or the resolved default).
 * Unknown models fall back to the default — pricing lookups must never
 * break a rendering path, so we degrade instead of throwing.
 */
export function pricing(model?: string): ModelPrice {
  const name = pricingModel(model);
  return PRICING_TABLE[name] ?? PRICING_TABLE[DEFAULT_PRICING_MODEL]!;
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
