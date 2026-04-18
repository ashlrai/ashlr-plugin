#!/usr/bin/env bun
/**
 * stripe-setup.ts — Idempotent Stripe product + price bootstrap.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_... bun run src/cli/stripe-setup.ts
 *
 * Creates the following products and prices if they don't already exist
 * in the stripe_products DB table:
 *
 *   pro          — ashlr Pro, $12/month
 *   pro-annual   — ashlr Pro, $120/year
 *   team         — ashlr Team, $24/seat/month
 *   team-annual  — ashlr Team, $240/seat/year
 *
 * Re-running is safe: existing entries are skipped.
 */

import Stripe from "stripe";
import { getDb, getStripeProduct, upsertStripeProduct } from "../db.js";

const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
if (!STRIPE_SECRET_KEY) {
  console.error("Error: STRIPE_SECRET_KEY environment variable is not set.");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });

// Ensure DB is initialised
getDb();

interface PriceSpec {
  key: string;
  productName: string;
  productDescription: string;
  unitAmount: number;   // cents
  interval: "month" | "year";
  perSeat: boolean;
}

const SPECS: PriceSpec[] = [
  {
    key: "pro",
    productName: "ashlr Pro",
    productDescription: "Cloud LLM summarizer, cross-machine stats sync, and hosted retrieval for one developer.",
    unitAmount: 1200,
    interval: "month",
    perSeat: false,
  },
  {
    key: "pro-annual",
    productName: "ashlr Pro",
    productDescription: "Cloud LLM summarizer, cross-machine stats sync, and hosted retrieval for one developer.",
    unitAmount: 12000,
    interval: "year",
    perSeat: false,
  },
  {
    key: "team",
    productName: "ashlr Team",
    productDescription: "ashlr Pro for engineering teams — shared genome sync, team dashboard, and priority support.",
    unitAmount: 2400,
    interval: "month",
    perSeat: true,
  },
  {
    key: "team-annual",
    productName: "ashlr Team",
    productDescription: "ashlr Pro for engineering teams — shared genome sync, team dashboard, and priority support.",
    unitAmount: 24000,
    interval: "year",
    perSeat: true,
  },
];

async function ensureProduct(name: string): Promise<string> {
  // Search for an existing product by name to avoid duplicates on re-run.
  const list = await stripe.products.list({ limit: 100, active: true });
  const existing = list.data.find((p) => p.name === name);
  if (existing) {
    console.log(`  Product "${name}" already exists: ${existing.id}`);
    return existing.id;
  }

  const product = await stripe.products.create({ name });
  console.log(`  Created product "${name}": ${product.id}`);
  return product.id;
}

async function ensurePrice(spec: PriceSpec, productId: string): Promise<string> {
  // Check DB first — if we already recorded this price, skip Stripe entirely.
  const cached = getStripeProduct(spec.key);
  if (cached) {
    console.log(`  Price key "${spec.key}" already in DB: ${cached.price_id} (skipping)`);
    return cached.price_id;
  }

  // Search existing prices on this product
  const list = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const match = list.data.find(
    (p) =>
      p.unit_amount === spec.unitAmount &&
      p.recurring?.interval === spec.interval,
  );

  let priceId: string;
  if (match) {
    console.log(`  Price for "${spec.key}" already exists on Stripe: ${match.id}`);
    priceId = match.id;
  } else {
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: spec.unitAmount,
      currency: "usd",
      recurring: {
        interval: spec.interval,
        ...(spec.perSeat ? { usage_type: "licensed" } : {}),
      },
      metadata: { ashlr_key: spec.key },
    });
    console.log(`  Created price for "${spec.key}": ${price.id}`);
    priceId = price.id;
  }

  upsertStripeProduct(spec.key, productId, priceId);
  console.log(`  Stored "${spec.key}" in stripe_products table.`);
  return priceId;
}

async function main(): Promise<void> {
  console.log("ashlr Stripe setup — bootstrapping products and prices...\n");

  // Process Pro specs (single product, two prices)
  const proProductId   = await ensureProduct("ashlr Pro");
  const teamProductId  = await ensureProduct("ashlr Team");

  for (const spec of SPECS) {
    console.log(`\nProcessing "${spec.key}":`);
    const productId = spec.key.startsWith("team") ? teamProductId : proProductId;
    await ensurePrice(spec, productId);
  }

  console.log("\nStripe setup complete.");
  console.log("\nCurrent stripe_products table:");
  const db = getDb();
  const rows = db.query(`SELECT key, product_id, price_id FROM stripe_products ORDER BY key`).all();
  for (const row of rows as Array<{ key: string; product_id: string; price_id: string }>) {
    console.log(`  ${row.key.padEnd(14)} product=${row.product_id}  price=${row.price_id}`);
  }
}

await main();
