import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, createUser, setUserTier, storePendingAuthToken } from "../src/db.js";
import { _clearBuckets } from "../src/lib/ratelimit.js";

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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  return db;
}

describe("auth middleware (GET /stats/aggregate)", () => {
  beforeEach(() => {
    _setDb(makeTestDb());
    _clearBuckets();
  });

  afterEach(() => {
    _resetDb();
    _clearBuckets();
  });

  it("returns 401 when Authorization header is absent", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/aggregate"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization header has wrong scheme", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/aggregate", {
      headers: { "Authorization": "Basic dXNlcjpwYXNz" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when bearer token is not in DB", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/aggregate", {
      headers: { "Authorization": "Bearer not-a-real-token-00000000000000000" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 200 when a valid token is provided", async () => {
    const u = createUser("auth-valid@example.com", "valid-auth-token-00000000000000000");
    setUserTier(u.id, "pro"); // stats/aggregate requires a paid tier
    const res = await app.fetch(new Request("http://localhost/stats/aggregate", {
      headers: { "Authorization": "Bearer valid-auth-token-00000000000000000" },
    }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Magic-link auth: POST /auth/send + POST /auth/verify
// ---------------------------------------------------------------------------

async function post(path: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /auth/send + POST /auth/verify", () => {
  let db: Database;

  beforeEach(() => {
    process.env["TESTING"] = "1";
    db = makeTestDb();
    _setDb(db);
  });

  afterEach(() => {
    _resetDb();
    delete process.env["TESTING"];
  });

  // 1. Valid email returns { sent: true }
  it("returns { sent: true } for a valid email", async () => {
    const res = await post("/auth/send", { email: "user@example.com" });
    expect(res.status).toBe(200);
    const body = await res.json() as { sent: boolean };
    expect(body.sent).toBe(true);
  });

  // 2. Magic token row is created in DB
  it("inserts a magic_tokens row after /auth/send", async () => {
    await post("/auth/send", { email: "persist@example.com" });
    const row = db
      .query<{ token: string; email: string }, [string]>(
        `SELECT token, email FROM magic_tokens WHERE email = ?`,
      )
      .get("persist@example.com");
    expect(row).not.toBeNull();
    expect(row!.email).toBe("persist@example.com");
    expect(row!.token).toHaveLength(64);
  });

  // 3. Invalid email format → 400
  it("returns 400 for an invalid email", async () => {
    const res = await post("/auth/send", { email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  // 4. Happy-path verify: returns apiToken + userId + email
  it("POST /auth/verify returns apiToken, userId, email on success", async () => {
    await post("/auth/send", { email: "verify@example.com" });
    const row = db
      .query<{ token: string }, [string]>(
        `SELECT token FROM magic_tokens WHERE email = ?`,
      )
      .get("verify@example.com");
    expect(row).not.toBeNull();

    const res = await post("/auth/verify", { token: row!.token });
    expect(res.status).toBe(200);
    const body = await res.json() as { apiToken: string; userId: string; email: string };
    expect(typeof body.apiToken).toBe("string");
    expect(body.apiToken).toHaveLength(64);
    expect(typeof body.userId).toBe("string");
    expect(body.email).toBe("verify@example.com");
  });

  // 5. Token row is marked used after verify
  it("marks the magic token as used after /auth/verify", async () => {
    await post("/auth/send", { email: "used@example.com" });
    const row = db
      .query<{ token: string }, [string]>(
        `SELECT token FROM magic_tokens WHERE email = ?`,
      )
      .get("used@example.com");

    await post("/auth/verify", { token: row!.token });

    const after = db
      .query<{ used_at: string | null }, [string]>(
        `SELECT used_at FROM magic_tokens WHERE token = ?`,
      )
      .get(row!.token);
    expect(after!.used_at).not.toBeNull();
  });

  // 6. Invalid/unknown token → 400
  it("returns 400 for an unknown token", async () => {
    const res = await post("/auth/verify", { token: "a".repeat(64) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid or expired link");
  });

  // 7. Already-used token → 400
  it("returns 400 when token is already used", async () => {
    await post("/auth/send", { email: "reuse@example.com" });
    const row = db
      .query<{ token: string }, [string]>(
        `SELECT token FROM magic_tokens WHERE email = ?`,
      )
      .get("reuse@example.com");

    const first = await post("/auth/verify", { token: row!.token });
    expect(first.status).toBe(200);

    const second = await post("/auth/verify", { token: row!.token });
    expect(second.status).toBe(400);
    const body = await second.json() as { error: string };
    expect(body.error).toBe("invalid or expired link");
  });

  // 8. Expired token → 400
  it("returns 400 for an expired token", async () => {
    const expiredToken = "e".repeat(64);
    const pastExpiry   = new Date(Date.now() - 1000).toISOString();
    db.run(
      `INSERT INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)`,
      [expiredToken, "expired@example.com", pastExpiry],
    );
    const userId = crypto.randomUUID();
    db.run(
      `INSERT INTO users (id, email, api_token) VALUES (?, ?, ?)`,
      [userId, "expired@example.com", crypto.randomUUID()],
    );

    const res = await post("/auth/verify", { token: expiredToken });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid or expired link");
  });

  // 9. Rate limit: 6th POST /auth/send for same email within 1 hour → 429
  it("returns 429 on the 6th POST /auth/send within 1 hour for same email", async () => {
    const email = "ratelimit@example.com";
    for (let i = 0; i < 5; i++) {
      const r = await post("/auth/send", { email });
      expect(r.status).toBe(200);
    }
    const sixth = await post("/auth/send", { email });
    expect(sixth.status).toBe(429);
  });

  // 10. TESTING=1 skips real email send but still creates the token row
  it("TESTING=1 skips email send but still creates magic token row", async () => {
    const email = "testmode@example.com";
    const res = await post("/auth/send", { email });
    expect(res.status).toBe(200);
    const row = db
      .query<{ token: string }, [string]>(
        `SELECT token FROM magic_tokens WHERE email = ?`,
      )
      .get(email);
    expect(row).not.toBeNull();
    expect(row!.token).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/status?email= — upgrade-flow polling endpoint
// ---------------------------------------------------------------------------

async function get(path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`));
}

describe("GET /auth/status", () => {
  let db: Database;

  beforeEach(() => {
    process.env["TESTING"] = "1";
    db = makeTestDb();
    _setDb(db);
  });

  afterEach(() => {
    _resetDb();
    delete process.env["TESTING"];
  });

  // 1. Returns { ready: false } when no pending token exists for the email
  it("returns { ready: false } before magic link is verified", async () => {
    const res = await get("/auth/status?email=waiting@example.com");
    expect(res.status).toBe(200);
    const body = await res.json() as { ready: boolean };
    expect(body.ready).toBe(false);
  });

  // 2. Returns { ready: true, apiToken } after verify stores a pending token
  it("returns { ready: true, apiToken } once pending token is available", async () => {
    const email = "ready@example.com";
    const fakeToken = "a".repeat(64);

    storePendingAuthToken(email, fakeToken);

    const res = await get(`/auth/status?email=${encodeURIComponent(email)}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ready: boolean; apiToken?: string };
    expect(body.ready).toBe(true);
    expect(body.apiToken).toBe(fakeToken);
  });

  // 3. Single-use semantics: second poll returns { ready: false }
  it("returns { ready: false } on the second poll (single-use)", async () => {
    const email = "oneshot@example.com";
    const fakeToken = "b".repeat(64);

    storePendingAuthToken(email, fakeToken);

    // First poll — should succeed
    const first = await get(`/auth/status?email=${encodeURIComponent(email)}`);
    const firstBody = await first.json() as { ready: boolean };
    expect(firstBody.ready).toBe(true);

    // Second poll — token consumed, should be not ready
    const second = await get(`/auth/status?email=${encodeURIComponent(email)}`);
    const secondBody = await second.json() as { ready: boolean };
    expect(secondBody.ready).toBe(false);
  });
});
