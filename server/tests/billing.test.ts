/**
 * billing.test.ts — Tests for the Stripe billing endpoints (Phase 3).
 *
 * All Stripe API calls are stubbed. TESTING=1 is set so getStripeClient()
 * returns a client initialised with a dummy key; individual methods are
 * replaced with mock() before each test.
 *
 * Tests:
 *  1. POST /billing/checkout — free user gets a session URL
 *  2. POST /billing/checkout — pro user gets 400 "already subscribed"
 *  3. POST /billing/checkout — invalid tier gets 400
 *  4. GET  /billing/portal  — user with subscription gets portal URL
 *  5. GET  /billing/portal  — user without subscription gets 404
 *  6. GET  /billing/status  — new user returns free tier
 *  7. GET  /billing/status  — subscribed user returns correct tier
 *  8. POST /billing/webhook — checkout.session.completed creates record + bumps tier
 *  9. POST /billing/webhook — invalid signature returns 400
 * 10. POST /billing/webhook — duplicate event_id returns 200 idempotent
 * 11. POST /billing/webhook — customer.subscription.deleted downgrades to free
 * 12. POST /llm/summarize   — free user gets 403
 * 13. POST /llm/summarize   — pro user gets through tier gate (may fail at LLM layer)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, createUser, setUserTier } from "../src/db.js";
import { _resetStripeClient, _setPriceCache } from "../src/lib/stripe.js";

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------

process.env["TESTING"] = "1";
process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_test_secret";
process.env["XAI_API_KEY"] = "xai-test";

// ---------------------------------------------------------------------------
// Stripe mock helpers
// ---------------------------------------------------------------------------

// We import the Stripe module so we can reach into the singleton after init.
import { getStripeClient } from "../src/lib/stripe.js";

function buildFakeEvent(
  type: string,
  data: object,
  id = "evt_test_" + Math.random().toString(36).slice(2),
): { raw: string; sig: string; event: object } {
  const event = { id, type, data: { object: data } };
  const raw = JSON.stringify(event);
  // We will mock stripe.webhooks.constructEvent to return the event directly.
  return { raw, sig: "t=1,v1=fakesig", event };
}

// ---------------------------------------------------------------------------
// Per-test DB + Stripe reset
// ---------------------------------------------------------------------------

let testDb: Database;

beforeEach(() => {
  testDb = new Database(":memory:");
  _setDb(testDb); // runs migrations on the in-memory DB
  _resetStripeClient();
  _setPriceCache({
    pro: "price_pro_monthly",
    "pro-annual": "price_pro_annual",
    team: "price_team_monthly",
    "team-annual": "price_team_annual",
  });
});

afterEach(() => {
  _resetDb();
  testDb.close();
  _resetStripeClient();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(email = "test@example.com", tier = "free") {
  const user = createUser(email, "token-" + Math.random().toString(36).slice(2));
  if (tier !== "free") setUserTier(user.id, tier);
  return user;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// ---------------------------------------------------------------------------
// 1. POST /billing/checkout — free user creates session
// ---------------------------------------------------------------------------

describe("POST /billing/checkout", () => {
  it("free user receives a checkout URL", async () => {
    const user = makeUser("free@example.com", "free");

    // Stub stripe.checkout.sessions.create
    const stripe = getStripeClient();
    (stripe.checkout.sessions as unknown as Record<string, unknown>).create = mock(async () => ({
      url: "https://checkout.stripe.com/pay/cs_test_123",
    }));

    const res = await app.request("/billing/checkout", {
      method: "POST",
      headers: authHeaders(user.api_token),
      body: JSON.stringify({ tier: "pro" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { url: string };
    expect(body.url).toContain("stripe.com");
  });

  it("first-time free user gets a 7-day trial in the checkout session", async () => {
    const user = makeUser("trial@example.com", "free");
    let capturedParams: Record<string, unknown> | null = null;

    const stripe = getStripeClient();
    (stripe.checkout.sessions as unknown as Record<string, unknown>).create = mock(
      async (params: Record<string, unknown>) => {
        capturedParams = params;
        return { url: "https://checkout.stripe.com/pay/cs_test_trial" };
      },
    );

    const res = await app.request("/billing/checkout", {
      method: "POST",
      headers: authHeaders(user.api_token),
      body: JSON.stringify({ tier: "pro" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { url: string; trial: { days: number } | null };
    expect(body.trial).toEqual({ days: 7 });
    expect(capturedParams).not.toBeNull();
    const params = capturedParams as unknown as {
      subscription_data?: { trial_period_days?: number };
      payment_method_collection?: string;
      metadata?: { trial?: string };
    };
    expect(params.subscription_data?.trial_period_days).toBe(7);
    expect(params.payment_method_collection).toBe("if_required");
    expect(params.metadata?.trial).toBe("7d");
  });

  it("returning user with prior subscription does NOT get another trial", async () => {
    const user = makeUser("returning@example.com", "free");
    // Seed a prior subscription (e.g., canceled pro sub).
    testDb.run(`
      INSERT INTO subscriptions (id, user_id, stripe_subscription_id, stripe_customer_id, tier, status, seats)
      VALUES ('sub-prior', ?, 'sub_stripe_prior', 'cus_prior', 'pro', 'canceled', 1)
    `, [user.id]);

    let capturedParams: Record<string, unknown> | null = null;
    const stripe = getStripeClient();
    (stripe.checkout.sessions as unknown as Record<string, unknown>).create = mock(
      async (params: Record<string, unknown>) => {
        capturedParams = params;
        return { url: "https://checkout.stripe.com/pay/cs_test_returning" };
      },
    );

    const res = await app.request("/billing/checkout", {
      method: "POST",
      headers: authHeaders(user.api_token),
      body: JSON.stringify({ tier: "pro" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { url: string; trial: unknown };
    expect(body.trial).toBeNull();
    const params = capturedParams as unknown as {
      subscription_data?: { trial_period_days?: number };
      metadata?: { trial?: string };
    };
    expect(params.subscription_data?.trial_period_days).toBeUndefined();
    expect(params.metadata?.trial).toBe("none");
  });

  it("ASHLR_DISABLE_TRIAL=1 bypasses the trial entirely", async () => {
    const user = makeUser("notrial@example.com", "free");
    process.env["ASHLR_DISABLE_TRIAL"] = "1";
    try {
      let capturedParams: Record<string, unknown> | null = null;
      const stripe = getStripeClient();
      (stripe.checkout.sessions as unknown as Record<string, unknown>).create = mock(
        async (params: Record<string, unknown>) => {
          capturedParams = params;
          return { url: "https://checkout.stripe.com/pay/cs_test_notrial" };
        },
      );

      const res = await app.request("/billing/checkout", {
        method: "POST",
        headers: authHeaders(user.api_token),
        body: JSON.stringify({ tier: "pro" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { trial: unknown };
      expect(body.trial).toBeNull();
      const params = capturedParams as unknown as {
        subscription_data?: { trial_period_days?: number };
      };
      expect(params.subscription_data).toBeUndefined();
    } finally {
      delete process.env["ASHLR_DISABLE_TRIAL"];
    }
  });

  it("pro user gets 400 already subscribed", async () => {
    const user = makeUser("pro@example.com", "pro");

    const res = await app.request("/billing/checkout", {
      method: "POST",
      headers: authHeaders(user.api_token),
      body: JSON.stringify({ tier: "pro" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/already subscribed/i);
  });

  it("invalid tier returns 400", async () => {
    const user = makeUser("bad@example.com", "free");

    const res = await app.request("/billing/checkout", {
      method: "POST",
      headers: authHeaders(user.api_token),
      body: JSON.stringify({ tier: "enterprise" }),
    });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 4-5. GET /billing/portal
// ---------------------------------------------------------------------------

describe("GET /billing/portal", () => {
  it("user with subscription gets portal URL", async () => {
    const user = makeUser("portal@example.com", "pro");

    // Insert a subscription record directly
    testDb.run(`
      INSERT INTO subscriptions (id, user_id, stripe_subscription_id, stripe_customer_id, tier, status, seats)
      VALUES ('sub-id-1', ?, 'sub_stripe_1', 'cus_test_1', 'pro', 'active', 1)
    `, [user.id]);

    const stripe = getStripeClient();
    (stripe.billingPortal.sessions as unknown as Record<string, unknown>).create = mock(async () => ({
      url: "https://billing.stripe.com/session/bps_test_1",
    }));

    const res = await app.request("/billing/portal", {
      method: "GET",
      headers: authHeaders(user.api_token),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { url: string };
    expect(body.url).toContain("stripe.com");
  });

  it("user without subscription gets 404", async () => {
    const user = makeUser("noportal@example.com", "free");

    const res = await app.request("/billing/portal", {
      method: "GET",
      headers: authHeaders(user.api_token),
    });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 6-7. GET /billing/status
// ---------------------------------------------------------------------------

describe("GET /billing/status", () => {
  it("new user returns free tier", async () => {
    const user = makeUser("status-free@example.com", "free");

    const res = await app.request("/billing/status", {
      headers: authHeaders(user.api_token),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { tier: string };
    expect(body.tier).toBe("free");
  });

  it("subscribed user returns correct tier and seats", async () => {
    const user = makeUser("status-pro@example.com", "pro");

    testDb.run(`
      INSERT INTO subscriptions (id, user_id, stripe_subscription_id, stripe_customer_id, tier, status, seats, current_period_end)
      VALUES ('sub-id-2', ?, 'sub_stripe_2', 'cus_test_2', 'pro', 'active', 1, '2026-05-17T00:00:00.000Z')
    `, [user.id]);

    const res = await app.request("/billing/status", {
      headers: authHeaders(user.api_token),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { tier: string; seats: number; renewsAt: string };
    expect(body.tier).toBe("pro");
    expect(body.seats).toBe(1);
    expect(body.renewsAt).toBe("2026-05-17T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// 8-11. POST /billing/webhook
// ---------------------------------------------------------------------------

describe("POST /billing/webhook", () => {
  function webhookRequest(rawBody: string, sig = "t=1,v1=fakesig") {
    return app.request("/billing/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": sig },
      body: rawBody,
    });
  }

  function stubConstructEvent(event: object) {
    const stripe = getStripeClient();
    (stripe.webhooks as unknown as Record<string, unknown>).constructEvent = mock(
      (_body: string, _sig: string, _secret: string) => event,
    );
  }

  it("checkout.session.completed creates subscription record and bumps user tier", async () => {
    const user = makeUser("webhook@example.com", "free");
    const stripeSubId = "sub_webhook_1";

    const sessionObj = {
      id: "cs_test_1",
      customer: "cus_wh_1",
      subscription: stripeSubId,
      metadata: { user_id: user.id, tier: "pro", seats: "1" },
    };

    const { raw, event } = buildFakeEvent("checkout.session.completed", sessionObj);
    stubConstructEvent(event);

    // Stub subscriptions.retrieve
    const stripe = getStripeClient();
    (stripe.subscriptions as unknown as Record<string, unknown>).retrieve = mock(async () => ({
      id: stripeSubId,
      status: "active",
      current_period_end: 1780000000,
      cancel_at: null,
    }));

    const res = await webhookRequest(raw);
    expect(res.status).toBe(200);

    // Give the async handler a tick to complete
    await new Promise((r) => setTimeout(r, 50));

    const sub = testDb.query(`SELECT * FROM subscriptions WHERE stripe_subscription_id = ?`).get(stripeSubId) as {
      tier: string; user_id: string;
    } | null;
    expect(sub).not.toBeNull();
    expect(sub!.tier).toBe("pro");

    const updatedUser = testDb.query(`SELECT tier FROM users WHERE id = ?`).get(user.id) as { tier: string } | null;
    expect(updatedUser!.tier).toBe("pro");
  });

  it("invalid signature returns 400", async () => {
    const stripe = getStripeClient();
    (stripe.webhooks as unknown as Record<string, unknown>).constructEvent = mock(
      () => { throw new Error("No signatures found matching the expected signature for payload"); },
    );

    const res = await webhookRequest(JSON.stringify({ id: "evt_bad" }), "t=1,v1=badsig");
    expect(res.status).toBe(400);
  });

  it("duplicate event_id returns 200 and is idempotent", async () => {
    const eventId = "evt_dupe_1";
    // Pre-insert the event as already processed
    testDb.run(`INSERT INTO stripe_events (event_id) VALUES (?)`, [eventId]);

    const event = { id: eventId, type: "checkout.session.completed", data: { object: {} } };
    stubConstructEvent(event);

    const res = await webhookRequest(JSON.stringify(event));
    expect(res.status).toBe(200);
    const body = await res.json() as { skipped: boolean };
    expect(body.skipped).toBe(true);
  });

  it("duplicate delivery of same event_id only processes once", async () => {
    const user = makeUser("dedup@example.com", "free");
    const stripeSubId = "sub_dedup_parallel";
    const eventId = "evt_dedup_parallel_1";

    const sessionObj = {
      id: "cs_dedup_1",
      customer: "cus_dedup_1",
      subscription: stripeSubId,
      metadata: { user_id: user.id, tier: "pro", seats: "1" },
    };

    const event = { id: eventId, type: "checkout.session.completed", data: { object: sessionObj } };
    const raw = JSON.stringify(event);

    const stripe = getStripeClient();
    (stripe.webhooks as unknown as Record<string, unknown>).constructEvent = mock(
      (_body: string, _sig: string, _secret: string) => event,
    );

    let retrieveCallCount = 0;
    (stripe.subscriptions as unknown as Record<string, unknown>).retrieve = mock(async () => {
      retrieveCallCount++;
      return { id: stripeSubId, status: "active", current_period_end: 1780000000, cancel_at: null };
    });

    // Fire both deliveries concurrently — simulates Stripe double-delivery
    const [res1, res2] = await Promise.all([
      app.request("/billing/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=fakesig" },
        body: raw,
      }),
      app.request("/billing/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=fakesig" },
        body: raw,
      }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const bodies = await Promise.all([res1.json(), res2.json()]) as Array<{ ok?: boolean; skipped?: boolean }>;
    const skippedCount = bodies.filter((b) => b.skipped === true).length;
    const processedCount = bodies.filter((b) => b.ok === true && !b.skipped).length;
    expect(skippedCount).toBe(1);
    expect(processedCount).toBe(1);

    // Handler (subscriptions.retrieve) ran exactly once
    await new Promise((r) => setTimeout(r, 50));
    expect(retrieveCallCount).toBe(1);
  });

  it("handler throws on first delivery, subsequent retry succeeds", async () => {
    const user = makeUser("retry@example.com", "free");
    const stripeSubId = "sub_retry_1";
    const eventId = "evt_retry_1";

    const sessionObj = {
      id: "cs_retry_1",
      customer: "cus_retry_1",
      subscription: stripeSubId,
      metadata: { user_id: user.id, tier: "pro", seats: "1" },
    };

    const event = { id: eventId, type: "checkout.session.completed", data: { object: sessionObj } };
    const raw = JSON.stringify(event);

    const stripe = getStripeClient();
    (stripe.webhooks as unknown as Record<string, unknown>).constructEvent = mock(
      (_body: string, _sig: string, _secret: string) => event,
    );

    let callCount = 0;
    (stripe.subscriptions as unknown as Record<string, unknown>).retrieve = mock(async () => {
      callCount++;
      if (callCount === 1) throw new Error("Stripe retrieval failed");
      return { id: stripeSubId, status: "active", current_period_end: 1780000000, cancel_at: null };
    });

    // First delivery — handler throws, should return 500 and remove marker
    const res1 = await app.request("/billing/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=fakesig" },
      body: raw,
    });
    expect(res1.status).toBe(500);

    // Marker row must be absent so retry can re-enter
    const markerAfterFailure = testDb.query(`SELECT event_id FROM stripe_events WHERE event_id = ?`).get(eventId);
    expect(markerAfterFailure).toBeNull();

    // Second delivery (Stripe retry) — handler succeeds
    const res2 = await app.request("/billing/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=fakesig" },
      body: raw,
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as { ok: boolean };
    expect(body2.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    const updatedUser = testDb.query(`SELECT tier FROM users WHERE id = ?`).get(user.id) as { tier: string } | null;
    expect(updatedUser!.tier).toBe("pro");
  });

  it("customer.subscription.deleted downgrades user to free", async () => {
    const user = makeUser("deleted@example.com", "pro");
    const stripeSubId = "sub_del_1";

    testDb.run(`
      INSERT INTO subscriptions (id, user_id, stripe_subscription_id, stripe_customer_id, tier, status, seats)
      VALUES ('sub-del-id', ?, ?, 'cus_del_1', 'pro', 'active', 1)
    `, [user.id, stripeSubId]);

    const subObj = {
      id: stripeSubId,
      customer: "cus_del_1",
      status: "canceled",
      current_period_end: 1780000000,
      cancel_at: null,
    };

    const { raw, event } = buildFakeEvent("customer.subscription.deleted", subObj);
    stubConstructEvent(event);

    const res = await webhookRequest(raw);
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    const updatedUser = testDb.query(`SELECT tier FROM users WHERE id = ?`).get(user.id) as { tier: string } | null;
    expect(updatedUser!.tier).toBe("free");
  });
});

// ---------------------------------------------------------------------------
// 12-13. Tier-gated /llm/summarize
// ---------------------------------------------------------------------------

describe("tier gating on /llm/summarize", () => {
  it("free user gets 403", async () => {
    const user = makeUser("llm-free@example.com", "free");

    const res = await app.request("/llm/summarize", {
      method: "POST",
      headers: authHeaders(user.api_token),
      body: JSON.stringify({ text: "hello", systemPrompt: "summarize", toolName: "test" }),
    });

    expect(res.status).toBe(403);
    const body = await res.json() as { upgrade_url: string };
    expect(body.upgrade_url).toBe("/billing/checkout");
  });

  it("pro user passes tier gate (fails at missing LLM key layer, not 403)", async () => {
    const user = makeUser("llm-pro@example.com", "pro");
    delete process.env["XAI_API_KEY"];

    const res = await app.request("/llm/summarize", {
      method: "POST",
      headers: authHeaders(user.api_token),
      body: JSON.stringify({ text: "hello", systemPrompt: "summarize", toolName: "test" }),
    });

    // Tier gate passed — endpoint proceeds to xAI Grok call which fails with 502
    // (not 403, which would mean tier gate fired)
    expect(res.status).not.toBe(403);
    expect([200, 400, 429, 502]).toContain(res.status);

    process.env["XAI_API_KEY"] = "xai-test";
  });
});
