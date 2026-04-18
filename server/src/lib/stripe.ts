/**
 * stripe.ts — Stripe SDK singleton + price key registry.
 *
 * Use TESTING=1 to get a stub client that never calls the Stripe API.
 * Use STRIPE_SECRET_KEY for live/test mode.
 *
 * PRICE_KEYS maps tier strings to Stripe price IDs loaded from the DB
 * (populated by the stripe-setup CLI). In tests they resolve to fixture strings.
 */

import Stripe from "stripe";
import { getStripeProduct } from "../db.js";

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let _stripe: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (_stripe) return _stripe;

  if (process.env["TESTING"] === "1") {
    // Return a stub — tests override specific methods via mock()
    _stripe = new Stripe("sk_test_stub", { apiVersion: "2026-03-25.dahlia" });
    return _stripe;
  }

  const key = process.env["STRIPE_SECRET_KEY"];
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");

  _stripe = new Stripe(key, { apiVersion: "2026-03-25.dahlia" });
  return _stripe;
}

/** Reset singleton — for tests only. */
export function _resetStripeClient(): void {
  _stripe = null;
}

// ---------------------------------------------------------------------------
// Price key lookup
// ---------------------------------------------------------------------------

export type TierKey = "pro" | "pro-annual" | "team" | "team-annual";

/**
 * Lazy price-key map: reads from DB on first access per key.
 * Falls back to env vars for local dev without a seeded DB.
 */
const _priceCache: Partial<Record<TierKey, string>> = {};

function getPriceId(key: TierKey): string {
  if (_priceCache[key]) return _priceCache[key]!;

  const row = getStripeProduct(key);
  if (row) {
    _priceCache[key] = row.price_id;
    return row.price_id;
  }

  // Fallback to env (for dev/test)
  const envKey = `STRIPE_PRICE_${key.toUpperCase().replace(/-/g, "_")}`;
  const envVal = process.env[envKey];
  if (envVal) {
    _priceCache[key] = envVal;
    return envVal;
  }

  throw new Error(`No Stripe price ID found for key "${key}". Run stripe-setup or set ${envKey}.`);
}

/**
 * PRICE_KEYS is a Proxy so callers can do `PRICE_KEYS["pro"]` and always get
 * the current resolved price ID without a function call at the callsite.
 */
export const PRICE_KEYS: Record<TierKey, string> = new Proxy({} as Record<TierKey, string>, {
  get(_target, prop: string) {
    return getPriceId(prop as TierKey);
  },
});

/** Inject cached price IDs in tests without touching the DB. */
export function _setPriceCache(overrides: Partial<Record<TierKey, string>>): void {
  Object.assign(_priceCache, overrides);
}

/** Clear price cache — for tests. */
export function _clearPriceCache(): void {
  for (const k of Object.keys(_priceCache)) {
    delete _priceCache[k as TierKey];
  }
}
