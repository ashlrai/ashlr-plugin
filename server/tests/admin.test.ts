/**
 * admin.test.ts — Tests for /admin/* endpoints.
 *
 * Tests:
 *  1.  Non-admin user → GET /admin/overview → 403
 *  2.  No auth → GET /admin/overview → 401
 *  3.  Admin user → GET /admin/overview → 200 with correct shape
 *  4.  Admin → GET /admin/users → 200 with redacted emails
 *  5.  Admin → GET /admin/users/:id → 200 with full email
 *  6.  Admin → GET /admin/users/:id (non-existent) → 404
 *  7.  Admin → POST /admin/users/:id/comp → bumps tier + sets comp_expires_at
 *  8.  Admin → POST /admin/users/:id/comp → non-existent user → 404
 *  9.  Admin → POST /admin/users/:id/refund → Stripe stub → 200 + stripe_events row
 * 10.  Admin → POST /admin/broadcast without confirm:true → 400
 * 11.  Admin → POST /admin/broadcast with confirm:true → 200
 * 12.  Admin → POST /admin/broadcast second call within 1h → 429
 * 13.  Admin → GET /admin/revenue → 200 with timeline shape
 * 14.  Admin → GET /admin/audit → 200
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, createUser, setUserTier, setUserAdmin, getDb, _resetBroadcastRateLimit } from "../src/db.js";
import { _clearBuckets } from "../src/lib/ratelimit.js";
import * as stripeLib from "../src/lib/stripe.js";

// ---------------------------------------------------------------------------
// Test DB bootstrap
// ---------------------------------------------------------------------------

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function post(path: string, body: unknown, token: string) {
  return app.request(path, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function get(path: string, token?: string) {
  return app.request(path, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

// ---------------------------------------------------------------------------
// Stripe stub helpers
// ---------------------------------------------------------------------------

function stubStripeRefundOk(refundId = "re_test_001") {
  const fakeStripe = {
    subscriptions: {
      retrieve: mock(async () => ({
        latest_invoice: "in_test_001",
      })),
    },
    invoicePayments: {
      list: mock(async () => ({
        data: [{ payment: { payment_intent: "pi_test_001" } }],
      })),
    },
    paymentIntents: {
      retrieve: mock(async () => ({
        latest_charge: "ch_test_001",
      })),
    },
    refunds: {
      create: mock(async () => ({ id: refundId })),
    },
  } as unknown as import("stripe").default;

  mock.module("../src/lib/stripe.js", () => ({
    ...stripeLib,
    getStripeClient: () => fakeStripe,
  }));

  return fakeStripe;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("admin endpoints", () => {
  let db: Database;
  let adminToken: string;
  let regularToken: string;
  let adminUserId: string;
  let regularUserId: string;
  let targetUserId: string;
  let targetToken: string;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    _clearBuckets();
    _resetBroadcastRateLimit();
    process.env["TESTING"] = "1";

    // Create a regular (non-admin) user
    const regular = createUser("regular@example.com", "tok-regular-0000000000000000000000000000");
    regularToken = regular.api_token;
    regularUserId = regular.id;

    // Create admin user
    const admin = createUser("admin@example.com", "tok-admin-000000000000000000000000000000");
    adminToken = admin.api_token;
    adminUserId = admin.id;
    setUserAdmin(adminUserId, true);

    // Create a target user for detail/comp/refund tests
    const target = createUser("target@example.com", "tok-target-00000000000000000000000000000");
    targetToken = target.api_token;
    targetUserId = target.id;
    setUserTier(targetUserId, "pro");

    // Insert a fake subscription for refund test
    db.run(
      `INSERT INTO subscriptions (id, user_id, stripe_subscription_id, stripe_customer_id, tier, status, seats)
       VALUES ('sub-001', ?, 'sub_stripe_001', 'cus_stripe_001', 'pro', 'active', 1)`,
      [targetUserId],
    );
  });

  afterEach(() => {
    _resetDb();
  });

  // 1. Non-admin → 403
  it("non-admin user hitting /admin/overview → 403", async () => {
    const res = await get("/admin/overview", regularToken);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/admin/i);
  });

  // 2. No auth → 401
  it("no auth on /admin/overview → 401", async () => {
    const res = await get("/admin/overview");
    expect(res.status).toBe(401);
  });

  // 3. Admin → overview shape
  it("admin user → GET /admin/overview → 200 with correct shape", async () => {
    const res = await get("/admin/overview", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("counts");
    expect(body).toHaveProperty("recent_signups");
    expect(body).toHaveProperty("recent_payments");
    expect(body).toHaveProperty("llm_usage_by_tier");

    const counts = body.counts as Record<string, unknown>;
    expect(counts).toHaveProperty("total_users");
    expect(counts).toHaveProperty("active_pro");
    expect(counts).toHaveProperty("active_team");
    expect(counts).toHaveProperty("mrr_cents");
    expect(typeof counts.total_users).toBe("number");
  });

  // 4. Admin → users list, emails redacted
  it("admin → GET /admin/users → 200 with redacted emails", async () => {
    const res = await get("/admin/users", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { users: Array<{ email: string }> };
    expect(Array.isArray(body.users)).toBe(true);
    // All emails should be redacted (contain ***)
    for (const u of body.users) {
      expect(u.email).toContain("***");
    }
  });

  // 5. Admin → user detail, full email visible
  it("admin → GET /admin/users/:id → 200 with full email", async () => {
    const res = await get(`/admin/users/${targetUserId}`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { user: { email: string; tier: string } };
    expect(body.user.email).toBe("target@example.com");
    expect(body.user.tier).toBe("pro");
    expect(body).toHaveProperty("subscriptions");
    expect(body).toHaveProperty("recent_llm_calls");
  });

  // 6. Non-existent user → 404
  it("admin → GET /admin/users/nonexistent → 404", async () => {
    const res = await get("/admin/users/does-not-exist", adminToken);
    expect(res.status).toBe(404);
  });

  // 7. Comp bumps tier + sets comp_expires_at
  it("admin → POST /admin/users/:id/comp → bumps tier + sets comp_expires_at", async () => {
    const compExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const res = await post(`/admin/users/${targetUserId}/comp`, {
      tier: "team",
      comp_expires_at: compExpiresAt,
    }, adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; tier: string; comp_expires_at: string };
    expect(body.ok).toBe(true);
    expect(body.tier).toBe("team");

    // Verify DB
    const row = db.query<{ tier: string; comp_expires_at: string }, [string]>(
      `SELECT tier, comp_expires_at FROM users WHERE id = ?`,
    ).get(targetUserId);
    expect(row?.tier).toBe("team");
    expect(row?.comp_expires_at).toBe(compExpiresAt);

    // Verify audit log entry was created
    const audit = db.query<{ id: string }, [string]>(
      `SELECT id FROM audit_events WHERE tool = 'admin' AND user_id = ?`,
    ).get(adminUserId);
    expect(audit).not.toBeNull();
  });

  // 8. Comp on non-existent user → 404
  it("admin → POST /admin/users/nonexistent/comp → 404", async () => {
    const res = await post("/admin/users/no-such-id/comp", {
      tier: "pro",
      comp_expires_at: new Date(Date.now() + 86400000).toISOString(),
    }, adminToken);
    expect(res.status).toBe(404);
  });

  // 9. Refund creates stripe_events row
  it("admin → POST /admin/users/:id/refund → 200 + stripe_events row", async () => {
    stubStripeRefundOk("re_test_admin_001");

    const res = await post(`/admin/users/${targetUserId}/refund`, {
      amountCents: 1000,
      reason: "Customer requested refund",
    }, adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; refund_id: string };
    expect(body.ok).toBe(true);
    expect(body.refund_id).toBe("re_test_admin_001");

    // stripe_events row should exist
    const row = db.query<{ event_id: string }, [string]>(
      `SELECT event_id FROM stripe_events WHERE event_id = ?`,
    ).get("refund.manual.re_test_admin_001");
    expect(row).not.toBeNull();
  });

  // 10. Broadcast without confirm:true → 400
  it("admin → POST /admin/broadcast without confirm:true → 400", async () => {
    const res = await post("/admin/broadcast", {
      subject: "Hello world",
      body: "Test announcement",
    }, adminToken);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/confirm/i);
  });

  // 11. Broadcast with confirm:true → 200
  it("admin → POST /admin/broadcast with confirm:true → 200", async () => {
    const res = await post("/admin/broadcast", {
      confirm: true,
      subject: "Product launch!",
      body: "We launched something cool.",
    }, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; sent: number };
    expect(body.ok).toBe(true);
    expect(typeof body.sent).toBe("number");
  });

  // 12. Broadcast second call within 1h → 429
  it("admin → POST /admin/broadcast rate-limit → 429 on second call", async () => {
    const payload = { confirm: true, subject: "Hello", body: "Body text." };

    const first = await post("/admin/broadcast", payload, adminToken);
    expect(first.status).toBe(200);

    const second = await post("/admin/broadcast", payload, adminToken);
    expect(second.status).toBe(429);
  });

  // 13. Revenue endpoint shape
  it("admin → GET /admin/revenue → 200 with timeline shape", async () => {
    const res = await get("/admin/revenue", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { from: string; to: string; timeline: unknown[] };
    expect(body).toHaveProperty("from");
    expect(body).toHaveProperty("to");
    expect(Array.isArray(body.timeline)).toBe(true);
  });

  // 14. Audit endpoint accessible to admin
  it("admin → GET /admin/audit → 200", async () => {
    const res = await get("/admin/audit", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });
});
