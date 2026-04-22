/**
 * auth-github-scopeup.test.ts — Phase 7C scope step-up routes.
 *
 * Tests:
 *   - GET /auth/github/scope-up: 401 no auth, 403 free tier, 302 pro tier
 *   - GET /auth/github/scope-up: state HMAC validated on callback
 *   - GET /auth/github/scope-up/callback: exchanges code + overwrites encrypted token
 *   - Pro user can build private genome after step-up (scope present)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import {
  _setDb,
  _resetDb,
  createUser,
  setUserTier,
  upsertGitHubIdentity,
} from "../src/db.js";
import { _clearBuckets } from "../src/lib/ratelimit.js";
import { __resetKeyForTests, encrypt } from "../src/lib/crypto.js";

// ---------------------------------------------------------------------------
// Test DB — same schema as auth-github.test.ts
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
      tier TEXT NOT NULL DEFAULT 'free',
      github_id TEXT,
      github_login TEXT,
      github_access_token_encrypted TEXT,
      genome_encryption_key_encrypted TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0
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

const VALID_SID = "b".repeat(32);

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function makeUser(db: Database, email: string, tier: "free" | "pro" | "team") {
  const token = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
  const user = createUser(email, token);
  setUserTier(user.id, tier);
  // Re-read from db for full shape
  const row = db.query<{ id: string; api_token: string }, [string]>(
    `SELECT id, api_token FROM users WHERE id = ?`,
  ).get(user.id);
  return { id: user.id, api_token: row!.api_token, tier };
}

async function getReq(path: string, headers: HeadersInit = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }));
}

// ---------------------------------------------------------------------------
// GET /auth/github/scope-up
// ---------------------------------------------------------------------------

describe("GET /auth/github/scope-up", () => {
  let db: Database;

  beforeEach(() => {
    process.env["TESTING"] = "1";
    process.env["GITHUB_CLIENT_ID"] = "test_client_id";
    db = makeTestDb();
    _setDb(db);
    __resetKeyForTests();
    _clearBuckets();
  });

  afterEach(() => {
    _resetDb();
    __resetKeyForTests();
    _clearBuckets();
    delete process.env["TESTING"];
    delete process.env["GITHUB_CLIENT_ID"];
  });

  it("returns 401 with no Authorization header", async () => {
    const res = await getReq(`/auth/github/scope-up?sid=${VALID_SID}`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for free-tier user with upgrade message", async () => {
    const user = makeUser(db, "free@example.com", "free");
    const res = await getReq(
      `/auth/github/scope-up?sid=${VALID_SID}`,
      authHeaders(user.api_token),
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Pro tier required");
    expect(body.error).toContain("/pricing");
  });

  it("returns 302 redirect to GitHub for pro-tier user", async () => {
    const user = makeUser(db, "pro@example.com", "pro");
    const res = await getReq(
      `/auth/github/scope-up?sid=${VALID_SID}`,
      authHeaders(user.api_token),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("scope=");
    // Scope must include `repo` (superset)
    const url = new URL(location);
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toContain("repo");
    expect(scope).toContain("public_repo");
    expect(url.searchParams.get("allow_signup")).toBe("false");
  });

  it("returns 302 redirect for team-tier user", async () => {
    const user = makeUser(db, "team@example.com", "team");
    const res = await getReq(
      `/auth/github/scope-up?sid=${VALID_SID}`,
      authHeaders(user.api_token),
    );
    expect(res.status).toBe(302);
  });

  it("state in redirect starts with sid", async () => {
    const user = makeUser(db, "pro2@example.com", "pro");
    const res = await getReq(
      `/auth/github/scope-up?sid=${VALID_SID}`,
      authHeaders(user.api_token),
    );
    const location = res.headers.get("location") ?? "";
    const url = new URL(location);
    const state = url.searchParams.get("state") ?? "";
    expect(state.startsWith(VALID_SID + ".")).toBe(true);
  });

  it("returns 400 when sid is missing", async () => {
    const user = makeUser(db, "pro3@example.com", "pro");
    const res = await getReq("/auth/github/scope-up", authHeaders(user.api_token));
    expect(res.status).toBe(400);
  });

  it("returns 400 when sid is not 32 hex chars", async () => {
    const user = makeUser(db, "pro4@example.com", "pro");
    const res = await getReq(
      "/auth/github/scope-up?sid=tooshort",
      authHeaders(user.api_token),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/github/scope-up/callback
// ---------------------------------------------------------------------------

describe("GET /auth/github/scope-up/callback", () => {
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
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    _resetDb();
    __resetKeyForTests();
    _clearBuckets();
    globalThis.fetch = originalFetch;
    delete process.env["TESTING"];
    delete process.env["GITHUB_CLIENT_ID"];
    delete process.env["GITHUB_CLIENT_SECRET"];
  });

  /** Get a valid signed state for VALID_SID via the scope-up start endpoint */
  async function getScopeUpState(apiToken: string): Promise<string> {
    const res = await getReq(
      `/auth/github/scope-up?sid=${VALID_SID}`,
      authHeaders(apiToken),
    );
    const location = res.headers.get("location") ?? "";
    const url = new URL(location);
    return url.searchParams.get("state") ?? "";
  }

  it("returns 400 HTML when state is invalid", async () => {
    const res = await getReq("/auth/github/scope-up/callback?code=abc&state=bad");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Invalid or expired state");
  });

  it("returns 400 HTML when code is missing", async () => {
    const user = makeUser(db, "pro5@example.com", "pro");
    const state = await getScopeUpState(user.api_token);
    const res = await getReq(`/auth/github/scope-up/callback?state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("No authorisation code");
  });

  it("returns 502 when GitHub token exchange fails", async () => {
    const user = makeUser(db, "pro6@example.com", "pro");
    const state = await getScopeUpState(user.api_token);

    globalThis.fetch = mock(async (url: string) => {
      if (String(url).includes("access_token")) {
        return new Response(JSON.stringify({ error: "bad_verification_code" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const res = await getReq(
      `/auth/github/scope-up/callback?code=bad&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(502);
  });

  it("happy path: exchanges code, overwrites encrypted token, redirects to done page", async () => {
    const user = makeUser(db, "scopeup@example.com", "pro");

    // Pre-attach a github_id so the callback can find the user
    upsertGitHubIdentity({
      userId: user.id,
      githubId: "88888",
      githubLogin: "scopeuser",
      encryptedAccessToken: encrypt("old-token-public-repo-only"),
    });

    const state = await getScopeUpState(user.api_token);

    globalThis.fetch = mock(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("access_token")) {
        return new Response(JSON.stringify({ access_token: "gho_elevated_token", token_type: "bearer" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.endsWith("/user")) {
        return new Response(JSON.stringify({ id: 88888, login: "scopeuser", email: "scopeup@example.com", name: "Scope User" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const res = await getReq(
      `/auth/github/scope-up/callback?code=good&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/github/scope-up/done");
    expect(location).toContain(`sid=${VALID_SID}`);

    // Token must have been overwritten with the new elevated token
    const row = db.query<{ github_access_token_encrypted: string }, [string]>(
      `SELECT github_access_token_encrypted FROM users WHERE id = ?`,
    ).get(user.id);
    expect(row?.github_access_token_encrypted).toBeTruthy();
    // The new encrypted value must differ from "old-token-public-repo-only"
    // (we can't easily decrypt in-test without importing decrypt, but we verify it changed)
    const { decrypt } = await import("../src/lib/crypto.js");
    const decrypted = decrypt(row!.github_access_token_encrypted);
    expect(decrypted).toBe("gho_elevated_token");
  });
});

// ---------------------------------------------------------------------------
// ScopeUpRequiredError integration — POST /genome/build
// ---------------------------------------------------------------------------

describe("POST /genome/build — scope_up_required", () => {
  let db: Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    originalFetch = globalThis.fetch;
    process.env["TESTING"] = "1";
    _clearBuckets();
    __resetKeyForTests();
  });

  afterEach(() => {
    _resetDb();
    globalThis.fetch = originalFetch;
    _clearBuckets();
    __resetKeyForTests();
    delete process.env["TESTING"];
  });

  function makeFetchWithScope(hasRepoScope: boolean, isPrivate: boolean) {
    return mock(async (url: string) => {
      const urlStr = String(url);
      // Root API endpoint — returns x-oauth-scopes header
      if (urlStr === "https://api.github.com/") {
        return new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-oauth-scopes": hasRepoScope ? "read:user, public_repo, repo" : "read:user, public_repo",
          },
        });
      }
      // Repo visibility check
      if (urlStr.includes("api.github.com/repos/")) {
        return new Response(
          JSON.stringify({ private: isPrivate, name: "test-repo" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
  }

  it("returns 403 with error_code=scope_up_required for pro user + private repo + public_repo scope only", async () => {
    const user = makeUser(db, "scopegate@example.com", "pro");

    // Attach a github token (only public_repo scope)
    upsertGitHubIdentity({
      userId: user.id,
      githubId: "11111",
      githubLogin: "scopegate",
      encryptedAccessToken: encrypt("gho_public_only"),
    });

    globalThis.fetch = makeFetchWithScope(false, true) as unknown as typeof globalThis.fetch;

    const res = await app.request("/genome/build", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${user.api_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ owner: "foo", repo: "private-repo" }),
    });

    expect(res.status).toBe(403);
    const body = await res.json() as { error_code: string; scope_up_url: string };
    expect(body.error_code).toBe("scope_up_required");
    expect(body.scope_up_url).toBe("/auth/github/scope-up");
  });

  it("returns 202 for pro user + private repo + full repo scope", async () => {
    const user = makeUser(db, "scopeok@example.com", "pro");

    upsertGitHubIdentity({
      userId: user.id,
      githubId: "22222",
      githubLogin: "scopeok",
      encryptedAccessToken: encrypt("gho_with_repo_scope"),
    });

    globalThis.fetch = makeFetchWithScope(true, true) as unknown as typeof globalThis.fetch;

    const { spyOn } = await import("bun:test");
    const childProcess = await import("node:child_process");
    const execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, out: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "", stderr: "" });
      }) as unknown as typeof childProcess.execFile,
    );

    const res = await app.request("/genome/build", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${user.api_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ owner: "foo", repo: "private-repo" }),
    });

    expect(res.status).toBe(202);
    execFileSpy.mockRestore();
  });
});
