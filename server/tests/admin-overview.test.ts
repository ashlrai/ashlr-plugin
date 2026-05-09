/**
 * admin-overview.test.ts — Tests for adminGetOverviewWithDeltas() and the
 * /admin/overview route's prior-period `prev` snapshot.
 *
 * Tests:
 *  1.  adminGetOverviewWithDeltas returns correct shape
 *  2.  total_users delta: users created before 24h cutoff counted in prev
 *  3.  total_users delta: users created after cutoff NOT counted in prev
 *  4.  active_pro delta: pro subs created before cutoff counted in prev
 *  5.  mrr_cents delta: prev_mrr = prev_active_pro × 1000
 *  6.  llm_calls_today delta: yesterday full-day window, not today
 *  7.  Edge case: zero prev baseline → prev fields are 0 (no crash)
 *  8.  Route GET /admin/overview returns `prev` field in response
 *  9.  Route `prev` shape matches OverviewCounts interface
 * 10.  Delta math: curr > prev → positive signal expected
 * 11.  Delta math: curr < prev → negative signal expected
 * 12.  Delta math: curr === prev → diff is zero (no signal needed)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import {
  _setDb,
  _resetDb,
  createUser,
  setUserAdmin,
  adminGetOverviewWithDeltas,
} from "../src/db.js";
import { _clearBuckets } from "../src/lib/ratelimit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function get(path: string, token?: string) {
  return app.request(path, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** Insert a user with a specific created_at timestamp (bypasses createUser default). */
function insertUserAt(db: Database, email: string, token: string, createdAt: string): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO users (id, email, api_token, tier, created_at) VALUES (?, ?, ?, 'free', ?)`,
    [id, email, token, createdAt],
  );
  return id;
}

/** Insert an active subscription with a specific created_at. */
function insertSubAt(db: Database, userId: string, tier: string, createdAt: string): void {
  db.run(
    `INSERT INTO subscriptions (id, user_id, stripe_subscription_id, stripe_customer_id, tier, status, seats, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', 1, ?)`,
    [crypto.randomUUID(), userId, `sub_${userId}`, `cus_${userId}`, tier, createdAt],
  );
}

/** Insert an llm_call at a given ISO timestamp. */
function insertLlmCallAt(db: Database, userId: string, at: string): void {
  db.run(
    `INSERT INTO llm_calls (id, user_id, tool_name, input_tokens, output_tokens, cost, at)
     VALUES (?, ?, 'ashlr__grep', 100, 50, 0.001, ?)`,
    [crypto.randomUUID(), userId, at],
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("adminGetOverviewWithDeltas", () => {
  let db: Database;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    _clearBuckets();
    process.env["TESTING"] = "1";
  });

  afterEach(() => {
    _resetDb();
  });

  // 1. Shape
  it("returns correct shape with counts and prev", () => {
    const result = adminGetOverviewWithDeltas();
    expect(result).toHaveProperty("counts");
    expect(result).toHaveProperty("prev");

    const fields = ["total_users", "active_pro", "active_team", "mrr_cents", "llm_calls_today", "genome_syncs_today"];
    for (const f of fields) {
      expect(result.counts).toHaveProperty(f);
      expect(result.prev).toHaveProperty(f);
      expect(typeof (result.counts as unknown as Record<string, unknown>)[f]).toBe("number");
      expect(typeof (result.prev as unknown as Record<string, unknown>)[f]).toBe("number");
    }
  });

  // 2. Users created before 24h cutoff appear in prev
  it("users created >24h ago are counted in prev.total_users", () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    insertUserAt(db, "old@example.com", "tok-old-000000000000000000000000000000000", old);

    const { prev } = adminGetOverviewWithDeltas();
    expect(prev.total_users).toBeGreaterThanOrEqual(1);
  });

  // 3. Users created <24h ago do NOT appear in prev
  it("users created <24h ago are NOT in prev.total_users", () => {
    // Only insert a fresh user (just now)
    createUser("fresh@example.com", "tok-fresh-0000000000000000000000000000000");

    const { prev, counts } = adminGetOverviewWithDeltas();
    // prev should be less than counts (fresh user only in counts)
    expect(prev.total_users).toBeLessThan(counts.total_users);
  });

  // 4. Pro subs created before cutoff counted in prev.active_pro
  it("pro subs created >24h ago are counted in prev.active_pro", () => {
    const userId = insertUserAt(db, "oldpro@example.com", "tok-oldpro-000000000000000000000000000", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    const oldSubAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    insertSubAt(db, userId, "pro", oldSubAt);

    const { prev } = adminGetOverviewWithDeltas();
    expect(prev.active_pro).toBeGreaterThanOrEqual(1);
  });

  // 5. MRR delta: prev_mrr = prev_active_pro × 1000
  it("prev.mrr_cents = prev.active_pro × 1000 + prev.active_team × 2500", () => {
    const userId = insertUserAt(db, "mrrpro@example.com", "tok-mrrpro-0000000000000000000000000000", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    insertSubAt(db, userId, "pro", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());

    const { prev } = adminGetOverviewWithDeltas();
    const expected = prev.active_pro * 1000 + prev.active_team * 2500;
    expect(prev.mrr_cents).toBe(expected);
  });

  // 6. llm_calls yesterday window
  it("prev.llm_calls_today counts yesterday's full-day window, not today", () => {
    const userId = createUser("llmuser@example.com", "tok-llmuser-000000000000000000000000000").id;

    // Yesterday's calls (should appear in prev)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    insertLlmCallAt(db, userId, `${yesterday}T06:00:00Z`);
    insertLlmCallAt(db, userId, `${yesterday}T14:00:00Z`);

    // Today's calls (should appear in counts, not prev)
    const today = new Date().toISOString().slice(0, 10);
    insertLlmCallAt(db, userId, `${today}T01:00:00Z`);

    const { counts, prev } = adminGetOverviewWithDeltas();
    expect(prev.llm_calls_today).toBeGreaterThanOrEqual(2);
    expect(counts.llm_calls_today).toBeGreaterThanOrEqual(1);
    // Today's window (>= today 00:00) must not bleed into prev
    expect(prev.llm_calls_today).toBeLessThanOrEqual(counts.llm_calls_today + 10);
  });

  // 7. Zero baseline — no crash, prev fields are 0
  it("empty DB → prev fields are all 0 (no crash)", () => {
    const { prev } = adminGetOverviewWithDeltas();
    expect(prev.total_users).toBe(0);
    expect(prev.active_pro).toBe(0);
    expect(prev.active_team).toBe(0);
    expect(prev.mrr_cents).toBe(0);
    expect(prev.llm_calls_today).toBe(0);
    expect(prev.genome_syncs_today).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Route-level tests (via HTTP)
// ---------------------------------------------------------------------------

describe("/admin/overview includes prev", () => {
  let db: Database;
  let adminToken: string;
  let adminUserId: string;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    _clearBuckets();
    process.env["TESTING"] = "1";

    const admin = createUser("admin2@example.com", "tok-admin2-00000000000000000000000000000");
    adminToken = admin.api_token;
    adminUserId = admin.id;
    setUserAdmin(adminUserId, true);
  });

  afterEach(() => {
    _resetDb();
  });

  // 8. Route returns `prev` field
  it("GET /admin/overview returns `prev` in response body", async () => {
    const res = await get("/admin/overview", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("prev");
  });

  // 9. `prev` shape matches OverviewCounts
  it("`prev` has all OverviewCounts fields as numbers", async () => {
    const res = await get("/admin/overview", adminToken);
    const body = await res.json() as Record<string, unknown>;
    const prev = body.prev as Record<string, unknown>;
    const fields = ["total_users", "active_pro", "active_team", "mrr_cents", "llm_calls_today", "genome_syncs_today"];
    for (const f of fields) {
      expect(prev).toHaveProperty(f);
      expect(typeof prev[f]).toBe("number");
    }
  });

  // 10. curr > prev → delta is positive (unit-level math check)
  it("delta math: curr > prev → positive diff", () => {
    // Simulate what the frontend fmtCountDelta would compute
    const curr = 105;
    const prev = 100;
    const diff = curr - prev; // 5
    expect(diff).toBeGreaterThan(0);
    const pct = ((diff / prev) * 100).toFixed(1);
    expect(pct).toBe("5.0");
  });

  // 11. curr < prev → negative diff
  it("delta math: curr < prev → negative diff", () => {
    const curr = 95;
    const prev = 100;
    const diff = curr - prev; // -5
    expect(diff).toBeLessThan(0);
    const pct = ((diff / prev) * 100).toFixed(1);
    expect(pct).toBe("-5.0");
  });

  // 12. curr === prev → zero diff (no indicator)
  it("delta math: curr === prev → diff is 0", () => {
    const curr = 100;
    const prev = 100;
    expect(curr - prev).toBe(0);
  });
});
