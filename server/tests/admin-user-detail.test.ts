/**
 * admin-user-detail.test.ts — Focused tests for the user-detail drilldown.
 *
 * Tests:
 *  1.  GET /admin/users/:id → 200, AdminUserDetail shape
 *  2.  GET /admin/users/:id → full email (not redacted)
 *  3.  GET /admin/users/:id → includes subscriptions array
 *  4.  GET /admin/users/:id → includes stats_uploads array
 *  5.  GET /admin/users/:id → includes recent_llm_calls array
 *  6.  GET /admin/users/:id → includes active_genome_ids array
 *  7.  GET /admin/users/:id → includes numeric audit_event_count
 *  8.  GET /admin/users/nonexistent → 404
 *  9.  POST /admin/users/:id/comp → tier + comp_expires_at persisted in DB
 * 10.  POST /admin/users/:id/comp → audit log entry created
 * 11.  POST /admin/users/:id/comp → non-existent user → 404
 * 12.  POST /admin/users/:id/refund → Stripe stub → 200 + refund_id
 * 13.  POST /admin/users/:id/refund → stripe_events row persisted
 * 14.  POST /admin/users/:id/refund → audit log entry created
 * 15.  Non-admin → GET /admin/users/:id → 403
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import {
  _setDb,
  _resetDb,
  createUser,
  setUserAdmin,
  setUserTier,
  getDb,
} from "../src/db.js";
import { _clearBuckets } from "../src/lib/ratelimit.js";
import * as stripeLib from "../src/lib/stripe.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function get(path: string, token?: string) {
  return app.request(path, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function post(path: string, body: unknown, token: string) {
  return app.request(path, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

function stubStripeRefundOk(refundId = "re_detail_test_001") {
  // Include the full surface other tests (notably billing.test.ts) patch
  // so mock.module doesn't strand them with `undefined` on .checkout etc.
  // mock.module replacements persist for the test process — be inclusive.
  const fakeStripe = {
    subscriptions: {
      retrieve: mock(async () => ({ latest_invoice: "in_detail_001" })),
      list: mock(async () => ({ data: [] })),
      create: mock(async () => ({ id: "sub_stub" })),
      update: mock(async () => ({ id: "sub_stub" })),
    },
    invoicePayments: {
      list: mock(async () => ({
        data: [{ payment: { payment_intent: "pi_detail_001" } }],
      })),
    },
    paymentIntents: {
      retrieve: mock(async () => ({ latest_charge: "ch_detail_001" })),
    },
    refunds: {
      create: mock(async () => ({ id: refundId })),
    },
    checkout: {
      sessions: {
        create: mock(async () => ({ id: "cs_stub", url: "https://stub.example/cs" })),
      },
    },
    billingPortal: {
      sessions: {
        create: mock(async () => ({ id: "bps_stub", url: "https://stub.example/portal" })),
      },
    },
    customers: {
      create: mock(async () => ({ id: "cus_stub" })),
      retrieve: mock(async () => ({ id: "cus_stub" })),
    },
    webhooks: {
      constructEvent: mock(() => ({ id: "evt_stub", type: "noop" })),
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

describe("admin user-detail drilldown", () => {
  let db: Database;
  let adminToken: string;
  let adminUserId: string;
  let regularToken: string;
  let targetUserId: string;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    _clearBuckets();
    process.env["TESTING"] = "1";

    // Admin user
    const admin = createUser("admin-detail@example.com", "tok-admin-detail-000000000000000000000000");
    adminToken = admin.api_token;
    adminUserId = admin.id;
    setUserAdmin(adminUserId, true);

    // Non-admin
    const regular = createUser("regular-detail@example.com", "tok-regular-detail-00000000000000000000");
    regularToken = regular.api_token;

    // Target user
    const target = createUser("target-detail@example.com", "tok-target-detail-00000000000000000000000");
    targetUserId = target.id;
    setUserTier(targetUserId, "pro");

    // Subscription for refund tests
    db.run(
      `INSERT INTO subscriptions (id, user_id, stripe_subscription_id, stripe_customer_id, tier, status, seats)
       VALUES ('sub-detail-001', ?, 'sub_stripe_detail_001', 'cus_stripe_detail_001', 'pro', 'active', 1)`,
      [targetUserId],
    );
  });

  afterEach(() => {
    _resetDb();
  });

  // 1. Shape check
  it("GET /admin/users/:id → 200 with AdminUserDetail shape", async () => {
    const res = await get(`/admin/users/${targetUserId}`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("user");
    expect(body).toHaveProperty("subscriptions");
    expect(body).toHaveProperty("stats_uploads");
    expect(body).toHaveProperty("recent_llm_calls");
    expect(body).toHaveProperty("active_genome_ids");
    expect(body).toHaveProperty("audit_event_count");
  });

  // 2. Full email (not redacted)
  it("GET /admin/users/:id → full unredacted email", async () => {
    const res = await get(`/admin/users/${targetUserId}`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { user: { email: string } };
    expect(body.user.email).toBe("target-detail@example.com");
    expect(body.user.email).not.toContain("***");
  });

  // 3. Subscriptions array
  it("GET /admin/users/:id → subscriptions array contains the seeded sub", async () => {
    const res = await get(`/admin/users/${targetUserId}`, adminToken);
    const body = await res.json() as { subscriptions: Array<{ stripe_subscription_id: string }> };
    expect(Array.isArray(body.subscriptions)).toBe(true);
    const subIds = body.subscriptions.map((s) => s.stripe_subscription_id);
    expect(subIds).toContain("sub_stripe_detail_001");
  });

  // 4. Stats uploads array
  it("GET /admin/users/:id → stats_uploads is an array", async () => {
    const res = await get(`/admin/users/${targetUserId}`, adminToken);
    const body = await res.json() as { stats_uploads: unknown[] };
    expect(Array.isArray(body.stats_uploads)).toBe(true);
  });

  // 5. Recent LLM calls array
  it("GET /admin/users/:id → recent_llm_calls is an array", async () => {
    const res = await get(`/admin/users/${targetUserId}`, adminToken);
    const body = await res.json() as { recent_llm_calls: unknown[] };
    expect(Array.isArray(body.recent_llm_calls)).toBe(true);
  });

  // 6. Active genome IDs array
  it("GET /admin/users/:id → active_genome_ids is an array", async () => {
    const res = await get(`/admin/users/${targetUserId}`, adminToken);
    const body = await res.json() as { active_genome_ids: unknown[] };
    expect(Array.isArray(body.active_genome_ids)).toBe(true);
  });

  // 7. Audit event count is numeric
  it("GET /admin/users/:id → audit_event_count is a number", async () => {
    const res = await get(`/admin/users/${targetUserId}`, adminToken);
    const body = await res.json() as { audit_event_count: unknown };
    expect(typeof body.audit_event_count).toBe("number");
  });

  // 8. Non-existent user
  it("GET /admin/users/nonexistent → 404", async () => {
    const res = await get("/admin/users/does-not-exist-xyz", adminToken);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not found/i);
  });

  // 9. Comp persists tier + comp_expires_at
  it("POST /admin/users/:id/comp → tier + comp_expires_at written to DB", async () => {
    const compExpiresAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const res = await post(`/admin/users/${targetUserId}/comp`, {
      tier: "team",
      comp_expires_at: compExpiresAt,
    }, adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; tier: string };
    expect(body.ok).toBe(true);
    expect(body.tier).toBe("team");

    const row = db.query<{ tier: string; comp_expires_at: string }, [string]>(
      `SELECT tier, comp_expires_at FROM users WHERE id = ?`,
    ).get(targetUserId);
    expect(row?.tier).toBe("team");
    expect(row?.comp_expires_at).toBe(compExpiresAt);
  });

  // 10. Comp writes audit log
  it("POST /admin/users/:id/comp → audit_events row created for admin", async () => {
    const compExpiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await post(`/admin/users/${targetUserId}/comp`, {
      tier: "pro",
      comp_expires_at: compExpiresAt,
    }, adminToken);

    const audit = db.query<{ id: string; tool: string }, [string]>(
      `SELECT id, tool FROM audit_events WHERE tool = 'admin' AND user_id = ?`,
    ).get(adminUserId);
    expect(audit).not.toBeNull();
    expect(audit?.tool).toBe("admin");
  });

  // 11. Comp non-existent user
  it("POST /admin/users/nonexistent/comp → 404", async () => {
    const res = await post("/admin/users/no-such-id-xyz/comp", {
      tier: "pro",
      comp_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }, adminToken);
    expect(res.status).toBe(404);
  });

  // 12. Refund returns 200 + refund_id
  it("POST /admin/users/:id/refund → 200 with refund_id from Stripe stub", async () => {
    stubStripeRefundOk("re_detail_test_001");
    const res = await post(`/admin/users/${targetUserId}/refund`, {
      amountCents: 500,
      reason: "User requested within trial period",
    }, adminToken);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; refund_id: string };
    expect(body.ok).toBe(true);
    expect(body.refund_id).toBe("re_detail_test_001");
  });

  // 13. Refund persists stripe_events row
  it("POST /admin/users/:id/refund → stripe_events row inserted", async () => {
    stubStripeRefundOk("re_detail_test_002");
    await post(`/admin/users/${targetUserId}/refund`, {
      amountCents: 1000,
      reason: "Duplicate charge",
    }, adminToken);

    const row = db.query<{ event_id: string }, [string]>(
      `SELECT event_id FROM stripe_events WHERE event_id = ?`,
    ).get("refund.manual.re_detail_test_002");
    expect(row).not.toBeNull();
  });

  // 14. Refund writes audit log
  it("POST /admin/users/:id/refund → audit_events row created for admin", async () => {
    stubStripeRefundOk("re_detail_test_003");
    await post(`/admin/users/${targetUserId}/refund`, {
      amountCents: 2000,
      reason: "Goodwill gesture",
    }, adminToken);

    const audit = db.query<{ id: string }, [string]>(
      `SELECT id FROM audit_events WHERE tool = 'admin' AND user_id = ?`,
    ).get(adminUserId);
    expect(audit).not.toBeNull();
  });

  // 15. Non-admin blocked
  it("non-admin → GET /admin/users/:id → 403", async () => {
    const res = await get(`/admin/users/${targetUserId}`, regularToken);
    expect(res.status).toBe(403);
  });
});
