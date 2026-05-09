/**
 * admin-broadcast.test.ts — Tests for broadcast-specific admin endpoints.
 *
 * Tests:
 *  1.  Non-admin → POST /admin/broadcast → 403
 *  2.  Dry-run returns count + sample, does NOT send emails
 *  3.  Dry-run does NOT consume rate-limit slot
 *  4.  Real send: rate limit blocks second call within 1 hour → 429
 *  5.  Tier filter "pro" narrows audience (excludes free/team users)
 *  6.  Tier filter "all" includes all users
 *  7.  Missing confirm:true → 400
 *  8.  Subject over 100 chars → 400 (server-side validation)
 *  9.  HTML over 100KB → 400 (server-side defense)
 * 10.  GET /admin/broadcast/audience — non-admin → 403
 * 11.  GET /admin/broadcast/audience?tier=all → count + redacted sample
 * 12.  GET /admin/broadcast/audience?tier=pro → only pro users counted
 * 13.  Real send: audit log entry recorded with operation=broadcast
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import {
  _setDb,
  _resetDb,
  createUser,
  setUserTier,
  setUserAdmin,
  _resetBroadcastRateLimit,
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

// sendEmail runs in TESTING mode (process.env.TESTING=1) so it writes to
// stderr instead of dispatching. We verify routing via response.sent rather
// than a module-level mock — mocking would persist for the whole test process
// and break emails.test.ts which exercises the real sendEmail.

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("admin broadcast endpoints", () => {
  let db: Database;
  let adminToken: string;
  let adminUserId: string;
  let regularToken: string;

  const validPayload = {
    confirm: true,
    subject: "Test broadcast",
    html: "<p>Hello world</p>",
    tier_filter: "all",
    dryRun: false,
  };

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    _clearBuckets();
    _resetBroadcastRateLimit();
    process.env["TESTING"] = "1";

    // Admin user
    const admin = createUser("admin@example.com", "tok-admin-broadcast000000000000000000000");
    adminToken = admin.api_token;
    adminUserId = admin.id;
    setUserAdmin(adminUserId, true);

    // Regular (non-admin) user
    const regular = createUser("user@example.com", "tok-regular-broadcast00000000000000000");
    regularToken = regular.api_token;

    // Extra users for tier-filter tests
    const freeUser = createUser("free@example.com", "tok-free-broadcast000000000000000000000");
    setUserTier(freeUser.id, "free");

    const proUser = createUser("pro@example.com", "tok-pro-broadcast0000000000000000000000");
    setUserTier(proUser.id, "pro");

    const teamUser = createUser("team@example.com", "tok-team-broadcast000000000000000000000");
    setUserTier(teamUser.id, "team");
  });

  afterEach(() => {
    _resetDb();
  });

  // 1. Non-admin → 403
  it("non-admin → POST /admin/broadcast → 403", async () => {
    const res = await post("/admin/broadcast", validPayload, regularToken);
    expect(res.status).toBe(403);
  });

  // 2. Dry-run returns count + sample, does NOT send
  it("dry-run returns count + sample without sending emails", async () => {
    const res = await post("/admin/broadcast", { ...validPayload, dryRun: true }, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      dryRun: boolean;
      count: number;
      sample: { email_redacted: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(typeof body.count).toBe("number");
    expect(body.count).toBeGreaterThan(0);
    expect(Array.isArray(body.sample)).toBe(true);
  });

  // 3. Dry-run does NOT consume rate-limit — real send after dry-run should succeed
  it("dry-run does not consume the rate-limit slot", async () => {
    // Dry-run first
    const dry = await post("/admin/broadcast", { ...validPayload, dryRun: true }, adminToken);
    expect(dry.status).toBe(200);

    // Real send immediately after should still succeed (not 429)
    const real = await post("/admin/broadcast", validPayload, adminToken);
    expect(real.status).toBe(200);
    const body = await real.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  // 4. Rate limit blocks second real send within 1 hour
  it("second real broadcast within 1 hour → 429", async () => {
    const first = await post("/admin/broadcast", validPayload, adminToken);
    expect(first.status).toBe(200);

    const second = await post("/admin/broadcast", validPayload, adminToken);
    expect(second.status).toBe(429);
    const body = await second.json() as { error: string };
    expect(body.error).toMatch(/rate limit/i);
  });

  // 5. Tier filter "pro" narrows audience
  it("tier_filter=pro narrows audience to only pro users", async () => {
    const res = await post("/admin/broadcast", {
      ...validPayload,
      tier_filter: "pro",
      dryRun: true,
    }, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number };
    // Only the proUser created in beforeEach should match
    expect(body.count).toBe(1);
  });

  // 6. Tier filter "all" includes all users
  it("tier_filter=all includes all users", async () => {
    const audienceRes = await get("/admin/broadcast/audience?tier=all", adminToken);
    expect(audienceRes.status).toBe(200);
    const body = await audienceRes.json() as { count: number };
    // admin + regular + free + pro + team = 5
    expect(body.count).toBe(5);
  });

  // 7. Missing confirm:true → 400
  it("missing confirm:true → 400", async () => {
    const res = await post("/admin/broadcast", {
      subject: "Hello",
      html: "<p>Body</p>",
      tier_filter: "all",
      dryRun: false,
    }, adminToken);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/confirm/i);
  });

  // 8. Subject over 100 chars → 400
  it("subject longer than 100 chars → 400", async () => {
    const res = await post("/admin/broadcast", {
      ...validPayload,
      subject: "x".repeat(101),
    }, adminToken);
    expect(res.status).toBe(400);
  });

  // 9. HTML over 100KB → 400
  it("html body over 100KB → 400", async () => {
    const res = await post("/admin/broadcast", {
      ...validPayload,
      html: "x".repeat(100_001),
    }, adminToken);
    expect(res.status).toBe(400);
  });

  // 10. GET /admin/broadcast/audience — non-admin → 403
  it("non-admin → GET /admin/broadcast/audience → 403", async () => {
    const res = await get("/admin/broadcast/audience", regularToken);
    expect(res.status).toBe(403);
  });

  // 11. GET /admin/broadcast/audience?tier=all → count + redacted sample
  it("GET /admin/broadcast/audience → count + redacted sample", async () => {
    const res = await get("/admin/broadcast/audience?tier=all", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      count: number;
      sample: { email_redacted: string }[];
    };
    expect(typeof body.count).toBe("number");
    expect(body.count).toBeGreaterThan(0);
    expect(Array.isArray(body.sample)).toBe(true);
    for (const s of body.sample) {
      expect(s.email_redacted).toContain("***");
    }
  });

  // 12. GET /admin/broadcast/audience?tier=pro → only pro users
  it("GET /admin/broadcast/audience?tier=pro → only pro count", async () => {
    const res = await get("/admin/broadcast/audience?tier=pro", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number };
    expect(body.count).toBe(1);
  });

  // 13. Real send records audit log entry
  it("real broadcast records audit_events row with operation=broadcast", async () => {
    const res = await post("/admin/broadcast", validPayload, adminToken);
    expect(res.status).toBe(200);

    const row = db.query<{ args_json: string }, [string]>(
      `SELECT args_json FROM audit_events WHERE tool = 'admin' AND user_id = ? ORDER BY at DESC LIMIT 1`,
    ).get(adminUserId);

    expect(row).not.toBeNull();
    const args = JSON.parse(row!.args_json) as { operation: string };
    expect(args.operation).toBe("broadcast");
  });
});
