/**
 * billing.ts — Stripe subscription billing endpoints (Phase 3).
 *
 * POST /billing/checkout  — create a Checkout Session, return { url }
 * GET  /billing/portal    — create a Customer Portal session, return { url }
 * GET  /billing/status    — return caller's subscription state
 * POST /billing/webhook   — Stripe webhook handler (verify signature)
 *
 * All endpoints except /billing/webhook require Authorization: Bearer <token>.
 * Webhook verifies via Stripe-Signature header + STRIPE_WEBHOOK_SECRET.
 */

import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../lib/auth.js";
import {
  getSubscriptionByUserId,
  getSubscriptionByStripeSubId,
  getUserByStripeCustomerId,
  isStripeEventProcessed,
  markStripeEventProcessed,
  setUserTier,
  upsertSubscription,
} from "../db.js";
import { getStripeClient, PRICE_KEYS } from "../lib/stripe.js";

// Stripe v22 dropped current_period_end from the TypeScript types but the
// field still exists at runtime. Extend locally rather than cast at every use.
type StripeSub = import("stripe").Stripe.Subscription & {
  current_period_end: number;
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const billing = new Hono();

// ---------------------------------------------------------------------------
// POST /billing/checkout
// ---------------------------------------------------------------------------

const checkoutSchema = z.object({
  tier: z.enum(["pro", "team", "pro-annual", "team-annual"]),
  seats: z.number().int().min(1).optional().default(1),
});

billing.post("/billing/checkout", authMiddleware, async (c) => {
  const user = c.get("user");

  // If already on a paid plan, reject
  if (user.tier !== "free") {
    return c.json({ error: "Already subscribed. Use the portal to manage your subscription." }, 400);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
  }

  const { tier, seats } = parsed.data;
  const stripe = getStripeClient();
  const priceKey = PRICE_KEYS[tier];

  const isTeam = tier.startsWith("team");
  const quantity = isTeam ? seats : 1;

  const baseUrl = process.env["BASE_URL"] ?? "https://api.ashlr.ai";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: priceKey,
          quantity,
        },
      ],
      metadata: {
        user_id: user.id,
        tier,
        seats: String(seats),
      },
      customer_email: user.email,
      success_url: `${baseUrl}/billing/return?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env["SITE_URL"] ?? "https://plugin.ashlr.ai"}/pricing`,
    });

    return c.json({ url: session.url });
  } catch (err) {
    console.error("[billing/checkout] stripe error:", err instanceof Error ? err.message : err);
    return c.json({ error: "Failed to create checkout session" }, 502);
  }
});

// ---------------------------------------------------------------------------
// GET /billing/portal
// ---------------------------------------------------------------------------

billing.get("/billing/portal", authMiddleware, async (c) => {
  const user = c.get("user");
  const sub = getSubscriptionByUserId(user.id);

  if (!sub) {
    return c.json({ error: "No billing record found. Subscribe first." }, 404);
  }

  const stripe = getStripeClient();
  const baseUrl = process.env["BASE_URL"] ?? "https://api.ashlr.ai";

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${baseUrl}/billing/status`,
    });

    return c.json({ url: session.url });
  } catch (err) {
    console.error("[billing/portal] stripe error:", err instanceof Error ? err.message : err);
    return c.json({ error: "Failed to create portal session" }, 502);
  }
});

// ---------------------------------------------------------------------------
// GET /billing/status
// ---------------------------------------------------------------------------

billing.get("/billing/status", authMiddleware, (c) => {
  const user = c.get("user");
  const sub = getSubscriptionByUserId(user.id);

  if (!sub || sub.status === "canceled") {
    return c.json({ tier: "free", seats: 1, renewsAt: null, cancelAt: null });
  }

  return c.json({
    tier: sub.tier,
    seats: sub.seats,
    renewsAt: sub.current_period_end,
    cancelAt: sub.cancel_at,
  });
});

// ---------------------------------------------------------------------------
// POST /billing/webhook
// ---------------------------------------------------------------------------

billing.post("/billing/webhook", async (c) => {
  const stripe = getStripeClient();
  const webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];

  if (!webhookSecret) {
    console.error("[billing/webhook] STRIPE_WEBHOOK_SECRET not set");
    return c.json({ error: "Webhook secret not configured" }, 500);
  }

  const sig = c.req.header("stripe-signature");
  if (!sig) {
    return c.json({ error: "Missing Stripe-Signature header" }, 400);
  }

  const rawBody = await c.req.text();

  let event: import("stripe").Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("[billing/webhook] signature verification failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Invalid webhook signature" }, 400);
  }

  // Idempotency: skip already-processed events
  if (isStripeEventProcessed(event.id)) {
    return c.json({ ok: true, skipped: true });
  }

  // Process asynchronously so we return 200 immediately for heavy work
  void handleWebhookEvent(event);

  // Record event before returning to guard against duplicate delivery
  markStripeEventProcessed(event.id);

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Webhook event handlers
// ---------------------------------------------------------------------------

async function handleWebhookEvent(event: import("stripe").Stripe.Event): Promise<void> {
  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as import("stripe").Stripe.Checkout.Session);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object as StripeSub);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as StripeSub);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object as import("stripe").Stripe.Invoice);
        break;
      default:
        // Unhandled event type — log and ignore
        console.log(`[billing/webhook] unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error(`[billing/webhook] handler error for ${event.type}:`, err instanceof Error ? err.message : err);
  }
}

async function handleCheckoutCompleted(session: import("stripe").Stripe.Checkout.Session): Promise<void> {
  const userId = session.metadata?.["user_id"];
  const tier   = session.metadata?.["tier"] ?? "pro";
  const seats  = Number(session.metadata?.["seats"] ?? 1);

  if (!userId) {
    console.error("[billing/webhook] checkout.session.completed: missing user_id in metadata");
    return;
  }

  const customerId     = typeof session.customer === "string" ? session.customer : session.customer?.id ?? "";
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? "";

  if (!subscriptionId) {
    console.error("[billing/webhook] checkout.session.completed: no subscription id on session");
    return;
  }

  // Fetch the subscription to get period info
  const stripe = getStripeClient();
  const stripeSub = await stripe.subscriptions.retrieve(subscriptionId) as unknown as StripeSub;

  upsertSubscription({
    userId,
    stripeSubscriptionId: subscriptionId,
    stripeCustomerId: customerId,
    tier: normalizeTier(tier),
    status: stripeSub.status,
    seats,
    currentPeriodEnd: unixToIso(stripeSub.current_period_end),
    cancelAt: stripeSub.cancel_at ? unixToIso(stripeSub.cancel_at) : null,
  });

  setUserTier(userId, normalizeTier(tier));
  console.log(`[billing/webhook] checkout completed: user=${userId} tier=${tier} seats=${seats}`);
}

async function handleSubscriptionUpdated(sub: StripeSub): Promise<void> {
  const existing = getSubscriptionByStripeSubId(sub.id);
  if (!existing) {
    console.warn(`[billing/webhook] subscription.updated: unknown sub ${sub.id}`);
    return;
  }

  const seats = sub.items.data[0]?.quantity ?? existing.seats;
  const tier  = existing.tier; // keep existing tier unless items carry metadata

  upsertSubscription({
    userId: existing.user_id,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: existing.stripe_customer_id,
    tier,
    status: sub.status,
    seats,
    currentPeriodEnd: unixToIso(sub.current_period_end),
    cancelAt: sub.cancel_at ? unixToIso(sub.cancel_at) : null,
  });

  // If reactivated
  if (sub.status === "active") {
    setUserTier(existing.user_id, tier);
  }
}

async function handleSubscriptionDeleted(sub: StripeSub): Promise<void> {
  const existing = getSubscriptionByStripeSubId(sub.id);
  if (!existing) {
    // Try by customer
    const user = getUserByStripeCustomerId(typeof sub.customer === "string" ? sub.customer : sub.customer.id);
    if (!user) {
      console.warn(`[billing/webhook] subscription.deleted: unknown sub ${sub.id}`);
      return;
    }
    setUserTier(user.id, "free");
    return;
  }

  upsertSubscription({
    userId: existing.user_id,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: existing.stripe_customer_id,
    tier: "free",
    status: "canceled",
    seats: existing.seats,
    currentPeriodEnd: unixToIso(sub.current_period_end),
    cancelAt: sub.cancel_at ? unixToIso(sub.cancel_at) : null,
  });

  setUserTier(existing.user_id, "free");
  console.log(`[billing/webhook] subscription deleted: user=${existing.user_id} downgraded to free`);
}

async function handleInvoicePaymentFailed(invoice: import("stripe").Stripe.Invoice): Promise<void> {
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? "";
  const user = getUserByStripeCustomerId(customerId);

  if (!user) {
    console.warn(`[billing/webhook] invoice.payment_failed: unknown customer ${customerId}`);
    return;
  }

  // Flag account: set status to "past_due" but keep tier for 7-day grace period.
  // The subscription.deleted event will fire after Stripe exhausts retries.
  const sub = getSubscriptionByUserId(user.id);
  if (sub) {
    upsertSubscription({
      userId: sub.user_id,
      stripeSubscriptionId: sub.stripe_subscription_id,
      stripeCustomerId: sub.stripe_customer_id,
      tier: sub.tier,
      status: "past_due",
      seats: sub.seats,
      currentPeriodEnd: sub.current_period_end,
      cancelAt: sub.cancel_at,
    });
  }

  console.log(`[billing/webhook] payment failed for user=${user.id} — grace period active`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unixToIso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/** Map checkout tier strings like "pro-annual" → "pro" */
function normalizeTier(tier: string): string {
  if (tier.startsWith("team")) return "team";
  if (tier.startsWith("pro")) return "pro";
  return "free";
}

export default billing;
