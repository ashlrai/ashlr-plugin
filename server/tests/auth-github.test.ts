/**
 * auth-github.test.ts — GitHub OAuth backend routes (v1.13 Phase 7A.1)
 *
 * Tests /auth/github/start, /auth/github/callback, and the extended
 * /auth/status?session= endpoint. GitHub API calls are stubbed with
 * bun:test mock() — no real network traffic.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import {
  _setDb,
  _resetDb,
  storePendingAuthTokenBySid,
} from "../src/db.js";
import { _clearBuckets } from "../src/lib/ratelimit.js";
import { _clearIpBuckets } from "../src/lib/rate-limit.js";
import { __resetKeyForTests } from "../src/lib/crypto.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      api_token TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      tier TEXT NOT NULL DEFAULT 'free'
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS stats_uploads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      lifetime_calls INTEGER NOT NULL DEFAULT 0,
      lifetime_tokens_saved INTEGER NOT NULL DEFAULT 0,
      by_tool_json TEXT NOT NULL DEFAULT '{}',
      by_day_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_stats_uploads_user_id ON stats_uploads(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id    ON api_tokens(user_id);
    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date            TEXT NOT NULL,
      summarize_calls INTEGER NOT NULL DEFAULT 0,
      total_cost      REAL    NOT NULL DEFAULT 0.0,
      PRIMARY KEY (user_id, date)
    );
    CREATE TABLE IF NOT EXISTS llm_calls (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      tool_name     TEXT NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost          REAL    NOT NULL DEFAULT 0.0,
      cached        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id                     TEXT PRIMARY KEY,
      user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stripe_subscription_id TEXT NOT NULL UNIQUE,
      stripe_customer_id     TEXT NOT NULL,
      tier                   TEXT NOT NULL DEFAULT 'pro',
      status                 TEXT NOT NULL DEFAULT 'active',
      seats                  INTEGER NOT NULL DEFAULT 1,
      created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      current_period_end     TEXT,
      cancel_at              TEXT
    );
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id     TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE IF NOT EXISTS stripe_products (
      key        TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      price_id   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE IF NOT EXISTS magic_tokens (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      expires_at TEXT NOT NULL,
      used_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_magic_tokens_email ON magic_tokens(email);
    CREATE TABLE IF NOT EXISTS pending_auth_tokens (
      email      TEXT PRIMARY KEY,
      api_token  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_auth_tokens_session_id
      ON pending_auth_tokens(session_id) WHERE session_id IS NOT NULL;
  `);
  return db;
}

const VALID_SID = "a".repeat(32); // 32 hex chars

async function get(path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`));
}

// ---------------------------------------------------------------------------
// Fake GitHub responses
// ---------------------------------------------------------------------------

function makeFakeGitHubFetch(opts: {
  accessToken?: string;
  failToken?: boolean;
  userId?: number;
  login?: string;
  email?: string | null;
  emails?: Array<{ email: string; primary: boolean; verified: boolean }>;
}) {
  const {
    accessToken = "gho_test_token",
    failToken = false,
    userId = 12345,
    login = "testuser",
    email = "testuser@example.com",
    emails,
  } = opts;

  return mock(async (url: string, init?: RequestInit) => {
    const urlStr = String(url);

    if (urlStr.includes("login/oauth/access_token")) {
      if (failToken) {
        return new Response(JSON.stringify({ error: "bad_verification_code" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ access_token: accessToken, token_type: "bearer", scope: "read:user" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (urlStr.includes("/user/emails")) {
      const emailList = emails ?? [{ email: email ?? "testuser@example.com", primary: true, verified: true }];
      return new Response(JSON.stringify(emailList), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (urlStr.endsWith("/user")) {
      return new Response(
        JSON.stringify({ id: userId, login, email, name: "Test User" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Fallthrough — let real fetch handle anything else (shouldn't happen in tests)
    return new Response("not found", { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// GET /auth/github/start
// ---------------------------------------------------------------------------

describe("GET /auth/github/start", () => {
  let db: Database;

  beforeEach(() => {
    process.env["TESTING"] = "1";
    process.env["GITHUB_CLIENT_ID"] = "test_client_id";
    db = makeTestDb();
    _setDb(db);
    __resetKeyForTests();
    _clearBuckets();
    _clearIpBuckets();
  });

  afterEach(() => {
    _resetDb();
    __resetKeyForTests();
    _clearBuckets();
    _clearIpBuckets();
    delete process.env["TESTING"];
    delete process.env["GITHUB_CLIENT_ID"];
  });

  it("returns 400 when sid is missing", async () => {
    const res = await get("/auth/github/start");
    expect(res.status).toBe(400);
  });

  it("returns 400 when sid is not 32 hex chars (too short)", async () => {
    const res = await get("/auth/github/start?sid=abc123");
    expect(res.status).toBe(400);
  });

  it("returns 400 when sid contains non-hex characters", async () => {
    const res = await get("/auth/github/start?sid=" + "z".repeat(32));
    expect(res.status).toBe(400);
  });

  it("returns 500 when GITHUB_CLIENT_ID is not set", async () => {
    delete process.env["GITHUB_CLIENT_ID"];
    const res = await get(`/auth/github/start?sid=${VALID_SID}`);
    expect(res.status).toBe(500);
  });

  it("returns 302 redirect to github.com with valid sid", async () => {
    const res = await get(`/auth/github/start?sid=${VALID_SID}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test_client_id");
    expect(location).toContain("state=");
    expect(location).toContain("scope=");
  });

  it("signed state in redirect contains the sid", async () => {
    const res = await get(`/auth/github/start?sid=${VALID_SID}`);
    const location = res.headers.get("location") ?? "";
    const url = new URL(location);
    const state = url.searchParams.get("state") ?? "";
    // State format: sid.expiresMs.hmac — first segment is the sid
    expect(state.startsWith(VALID_SID + ".")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/github/callback
// ---------------------------------------------------------------------------

describe("GET /auth/github/callback", () => {
  let db: Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    process.env["TESTING"] = "1";
    process.env["GITHUB_CLIENT_ID"] = "test_client_id";
    process.env["GITHUB_CLIENT_SECRET"] = "test_client_secret";
    db = makeTestDb();
    _setDb(db);
    __resetKeyForTests();
    _clearBuckets();
    _clearIpBuckets();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    _resetDb();
    __resetKeyForTests();
    _clearBuckets();
    _clearIpBuckets();
    globalThis.fetch = originalFetch;
    delete process.env["TESTING"];
    delete process.env["GITHUB_CLIENT_ID"];
    delete process.env["GITHUB_CLIENT_SECRET"];
  });

  // Helper: get a valid signed state for VALID_SID
  async function getValidState(): Promise<string> {
    process.env["GITHUB_CLIENT_ID"] = "test_client_id";
    const res = await get(`/auth/github/start?sid=${VALID_SID}`);
    const location = res.headers.get("location") ?? "";
    const url = new URL(location);
    return url.searchParams.get("state") ?? "";
  }

  it("returns 400 HTML when state is invalid", async () => {
    const res = await get("/auth/github/callback?code=abc&state=invalid");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("invalid or expired state");
  });

  it("returns 400 HTML when code is missing", async () => {
    const state = await getValidState();
    const res = await get(`/auth/github/callback?state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("No authorisation code");
  });

  it("returns 502 when GitHub access_token exchange fails", async () => {
    const state = await getValidState();
    globalThis.fetch = makeFakeGitHubFetch({ failToken: true }) as unknown as typeof globalThis.fetch;

    const res = await get(`/auth/github/callback?code=bad_code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("access token");
  });

  it("happy path: creates new user, stores encrypted token, writes pending_auth_tokens, redirects", async () => {
    const state = await getValidState();
    globalThis.fetch = makeFakeGitHubFetch({
      userId: 99001,
      login: "newuser",
      email: "newuser@example.com",
    }) as unknown as typeof globalThis.fetch;

    const res = await get(`/auth/github/callback?code=good_code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/github/done");
    expect(location).toContain(`sid=${VALID_SID}`);

    // User row created
    const user = db
      .query<{ id: string; github_id: string; github_login: string }, []>(
        `SELECT id, github_id, github_login FROM users WHERE email = 'newuser@example.com'`,
      )
      .get();
    expect(user).not.toBeNull();
    expect(user!.github_id).toBe("99001");
    expect(user!.github_login).toBe("newuser");

    // Encrypted token stored
    const encRow = db
      .query<{ github_access_token_encrypted: string }, []>(
        `SELECT github_access_token_encrypted FROM users WHERE email = 'newuser@example.com'`,
      )
      .get();
    expect(encRow?.github_access_token_encrypted).toBeTruthy();

    // pending_auth_tokens entry written
    const pending = db
      .query<{ api_token: string }, [string]>(
        `SELECT api_token FROM pending_auth_tokens WHERE session_id = ?`,
      )
      .get(VALID_SID);
    expect(pending).not.toBeNull();
    expect(pending!.api_token).toHaveLength(64);
  });

  it("returning user matched by github_id preserves tier", async () => {
    // Pre-create a pro user with github_id set
    const userId = crypto.randomUUID();
    db.run(`INSERT INTO users (id, email, api_token, tier, github_id, github_login)
            VALUES (?, ?, ?, 'pro', '77777', 'prouser')`,
      [userId, "prouser@example.com", "existing-token-" + "x".repeat(48)]);
    db.run(`INSERT INTO api_tokens (token, user_id) VALUES (?, ?)`,
      ["existing-token-" + "x".repeat(48), userId]);

    const state = await getValidState();
    globalThis.fetch = makeFakeGitHubFetch({
      userId: 77777,
      login: "prouser",
      email: "prouser@example.com",
    }) as unknown as typeof globalThis.fetch;

    const res = await get(`/auth/github/callback?code=good_code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);

    // Tier must still be 'pro'
    const user = db
      .query<{ tier: string }, [string]>(`SELECT tier FROM users WHERE id = ?`)
      .get(userId);
    expect(user!.tier).toBe("pro");

    // No duplicate user rows
    const count = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM users WHERE github_id = '77777'`)
      .get();
    expect(count!.n).toBe(1);
  });

  it("email-only user (magic-link) gets github_id attached without creating duplicate", async () => {
    // Pre-create magic-link user with same email, no github_id
    const userId = crypto.randomUUID();
    db.run(`INSERT INTO users (id, email, api_token) VALUES (?, ?, ?)`,
      [userId, "merge@example.com", "ml-token-" + "x".repeat(55)]);
    db.run(`INSERT INTO api_tokens (token, user_id) VALUES (?, ?)`,
      ["ml-token-" + "x".repeat(55), userId]);

    const state = await getValidState();
    globalThis.fetch = makeFakeGitHubFetch({
      userId: 55555,
      login: "mergeuser",
      email: "merge@example.com",
    }) as unknown as typeof globalThis.fetch;

    const res = await get(`/auth/github/callback?code=good_code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);

    // Only one row for that email
    const count = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM users WHERE email = 'merge@example.com'`)
      .get();
    expect(count!.n).toBe(1);

    // github_id now attached to the existing user
    const user = db
      .query<{ id: string; github_id: string }, []>(
        `SELECT id, github_id FROM users WHERE email = 'merge@example.com'`,
      )
      .get();
    expect(user!.id).toBe(userId);
    expect(user!.github_id).toBe("55555");
  });

  it("private email fallback: fetches /user/emails when /user returns null email", async () => {
    const state = await getValidState();
    globalThis.fetch = makeFakeGitHubFetch({
      userId: 44444,
      login: "privateuser",
      email: null, // trigger fallback
      emails: [{ email: "private@example.com", primary: true, verified: true }],
    }) as unknown as typeof globalThis.fetch;

    const res = await get(`/auth/github/callback?code=good_code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);

    const user = db
      .query<{ email: string }, []>(`SELECT email FROM users WHERE github_id = '44444'`)
      .get();
    expect(user?.email).toBe("private@example.com");
  });
});

// ---------------------------------------------------------------------------
// GET /auth/status?session=<sid>
// ---------------------------------------------------------------------------

describe("GET /auth/status?session=<sid>", () => {
  let db: Database;

  beforeEach(() => {
    process.env["TESTING"] = "1";
    db = makeTestDb();
    _setDb(db);
    __resetKeyForTests();
    _clearBuckets();
    _clearIpBuckets();
  });

  afterEach(() => {
    _resetDb();
    __resetKeyForTests();
    _clearBuckets();
    _clearIpBuckets();
    delete process.env["TESTING"];
  });

  it("returns { ready: false } when no pending token exists for sid", async () => {
    const res = await get(`/auth/status?session=${VALID_SID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ready: boolean };
    expect(body.ready).toBe(false);
  });

  it("returns { ready: true, apiToken } after storePendingAuthTokenBySid", async () => {
    const fakeToken = "c".repeat(64);
    storePendingAuthTokenBySid(VALID_SID, fakeToken);

    const res = await get(`/auth/status?session=${VALID_SID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ready: boolean; apiToken?: string };
    expect(body.ready).toBe(true);
    expect(body.apiToken).toBe(fakeToken);
  });

  it("returns { ready: false } on second poll (single-use)", async () => {
    const fakeToken = "d".repeat(64);
    storePendingAuthTokenBySid(VALID_SID, fakeToken);

    const first = await get(`/auth/status?session=${VALID_SID}`);
    const firstBody = await first.json() as { ready: boolean };
    expect(firstBody.ready).toBe(true);

    const second = await get(`/auth/status?session=${VALID_SID}`);
    const secondBody = await second.json() as { ready: boolean };
    expect(secondBody.ready).toBe(false);
  });
});
