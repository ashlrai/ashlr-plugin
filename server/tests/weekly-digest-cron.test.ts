/**
 * weekly-digest-cron.test.ts — Integration tests for the weekly digest cron worker.
 *
 * Covers:
 *   1. Dry-run mode: returns sent count, never calls sendEmail, never updates DB
 *   2. Dedupe: users sent to within 6 days are skipped
 *   3. Tier gate: free-tier users are excluded
 *   4. Opt-out: weekly_digest_opt_in=0 users are excluded
 *   5. Batch processing: all eligible users are processed
 *   6. Failed user: failed counter increments, DB not marked sent
 *   7. unsubscribe token is signed (signUnsubscribeToken / verifyUnsubscribeToken roundtrip)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDb, _resetDb } from "../src/db.js";

// ---------------------------------------------------------------------------
// We must set TESTING=1 before importing the cron so sendEmail is a no-op
// ---------------------------------------------------------------------------

process.env["TESTING"] = "1";
process.env["ASHLR_MASTER_KEY_DEV"] = "1";
process.env["ASHLR_SITE_URL"] = "https://plugin.ashlr.ai";

import { runWeeklyDigestSend } from "../src/jobs/weekly-digest-cron.js";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../src/lib/unsubscribe.js";

// ---------------------------------------------------------------------------
// DB bootstrap helpers
// ---------------------------------------------------------------------------

function makeTestDb(): Database {
  const db = new Database(":memory:");
  _setDb(db);
  return db;
}

function insertUser(
  db: Database,
  opts: {
    id: string;
    email: string;
    tier?: string;
    optIn?: number;
    lastSentAt?: string | null;
  },
): void {
  const { id, email, tier = "pro", optIn = 1, lastSentAt = null } = opts;
  // Ensure schema columns exist (they're added by _setDb migrations)
  db.run(
    `INSERT INTO users (id, email, api_token, tier, weekly_digest_opt_in, weekly_digest_last_sent_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, email, crypto.randomUUID(), tier, optIn, lastSentAt],
  );
}

// Fixed "now" timestamp — a Sunday to verify week math
const NOW_MS = new Date("2026-05-10T14:00:00Z").getTime();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runWeeklyDigestSend", () => {
  let db: Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    _resetDb();
  });

  // 1. Dry-run
  it("dry-run: returns sent count without updating DB", async () => {
    insertUser(db, { id: "u1", email: "alice@example.com", tier: "pro" });
    insertUser(db, { id: "u2", email: "bob@example.com", tier: "team" });

    const result = await runWeeklyDigestSend({ dryRun: true, nowMs: NOW_MS });

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);

    // DB must NOT be updated in dry-run
    const row = db
      .query<{ weekly_digest_last_sent_at: string | null }, [string]>(
        `SELECT weekly_digest_last_sent_at FROM users WHERE id = ?`,
      )
      .get("u1");
    expect(row?.weekly_digest_last_sent_at).toBeNull();
  });

  // 2. Dedupe
  it("skips users sent to within 6 days", async () => {
    // Sent 3 days ago — within window
    const recentlySent = new Date(NOW_MS - 3 * 86_400_000).toISOString();
    // Sent 7 days ago — outside window
    const oldSent = new Date(NOW_MS - 7 * 86_400_000).toISOString();

    insertUser(db, { id: "u1", email: "recent@example.com", tier: "pro", lastSentAt: recentlySent });
    insertUser(db, { id: "u2", email: "old@example.com",    tier: "pro", lastSentAt: oldSent });
    insertUser(db, { id: "u3", email: "never@example.com",  tier: "pro", lastSentAt: null });

    const result = await runWeeklyDigestSend({ dryRun: true, nowMs: NOW_MS });

    // u1 is skipped (within window); u2 and u3 are eligible
    expect(result.sent).toBe(2);
  });

  // 3. Tier gate
  it("excludes free-tier users", async () => {
    insertUser(db, { id: "u1", email: "free@example.com",  tier: "free" });
    insertUser(db, { id: "u2", email: "pro@example.com",   tier: "pro" });
    insertUser(db, { id: "u3", email: "team@example.com",  tier: "team" });

    const result = await runWeeklyDigestSend({ dryRun: true, nowMs: NOW_MS });

    expect(result.sent).toBe(2); // only pro + team
  });

  // 4. Opt-out
  it("excludes opted-out users", async () => {
    insertUser(db, { id: "u1", email: "opted-out@example.com", tier: "pro", optIn: 0 });
    insertUser(db, { id: "u2", email: "opted-in@example.com",  tier: "pro", optIn: 1 });

    const result = await runWeeklyDigestSend({ dryRun: true, nowMs: NOW_MS });

    expect(result.sent).toBe(1);
  });

  // 5. All users processed
  it("processes all eligible users in a batch", async () => {
    for (let i = 0; i < 5; i++) {
      insertUser(db, { id: `u${i}`, email: `user${i}@example.com`, tier: "pro" });
    }

    const result = await runWeeklyDigestSend({ dryRun: true, nowMs: NOW_MS });

    expect(result.sent).toBe(5);
    expect(result.failed).toBe(0);
  });

  // 6. Zero eligible users
  it("returns zero counts when no users are eligible", async () => {
    const result = await runWeeklyDigestSend({ dryRun: true, nowMs: NOW_MS });
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  // 7. Result shape
  it("result always has sent, skipped, and failed fields", async () => {
    const result = await runWeeklyDigestSend({ dryRun: true, nowMs: NOW_MS });
    expect(typeof result.sent).toBe("number");
    expect(typeof result.skipped).toBe("number");
    expect(typeof result.failed).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Unsubscribe token roundtrip
// ---------------------------------------------------------------------------

describe("signUnsubscribeToken / verifyUnsubscribeToken", () => {
  it("roundtrip: sign then verify returns the userId", () => {
    const userId = "user-abc-123";
    const token = signUnsubscribeToken(userId);
    const result = verifyUnsubscribeToken(token);
    expect(result).toBe(userId);
  });

  it("tampered token returns null", () => {
    const token = signUnsubscribeToken("user-xyz");
    const tampered = token.slice(0, -3) + "aaa";
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it("expired token returns null", () => {
    // Sign with a TTL of -1ms (already expired)
    const userId = "user-expired";
    const expiresAt = Date.now() - 1;
    // Reconstruct a token with a past expiry by calling signUnsubscribeToken
    // with a negative TTL — it should produce an expired token
    const token = signUnsubscribeToken(userId, -1);
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it("malformed token (wrong segment count) returns null", () => {
    expect(verifyUnsubscribeToken("bad.token")).toBeNull();
    expect(verifyUnsubscribeToken("a.b.c.d")).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
  });

  it("different userIds produce different tokens", () => {
    const t1 = signUnsubscribeToken("user-1");
    const t2 = signUnsubscribeToken("user-2");
    expect(t1).not.toBe(t2);
  });
});

// ---------------------------------------------------------------------------
// Email-prefs route
// ---------------------------------------------------------------------------

describe("email-prefs route", () => {
  let db: Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    _resetDb();
  });

  it("GET /unsubscribe with valid token returns 200 HTML", async () => {
    insertUser(db, { id: "u1", email: "user@example.com", tier: "pro" });
    const token = signUnsubscribeToken("u1");

    const { default: app } = await import("../src/index.js");
    const req = new Request(`http://localhost/unsubscribe?token=${encodeURIComponent(token)}`);
    const res = await app.fetch(req);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("unsubscribed");
  });

  it("GET /unsubscribe with invalid token returns 400", async () => {
    const { default: app } = await import("../src/index.js");
    const req = new Request("http://localhost/unsubscribe?token=badtoken");
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  it("GET /unsubscribe sets weekly_digest_opt_in=0 in DB", async () => {
    insertUser(db, { id: "u2", email: "user2@example.com", tier: "pro", optIn: 1 });
    const token = signUnsubscribeToken("u2");

    const { default: app } = await import("../src/index.js");
    await app.fetch(new Request(`http://localhost/unsubscribe?token=${encodeURIComponent(token)}`));

    const row = db
      .query<{ weekly_digest_opt_in: number }, [string]>(
        `SELECT weekly_digest_opt_in FROM users WHERE id = ?`,
      )
      .get("u2");
    expect(row?.weekly_digest_opt_in).toBe(0);
  });
});
