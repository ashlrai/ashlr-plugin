/**
 * integration/oauth-returning-user.test.ts
 *
 * Returning-user path: a user who signed in via magic link (email row exists,
 * no github_id) then signs in with GitHub. The callback must attach the
 * GitHub identity to the EXISTING row — no duplicate user created.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../../src/index.js";
import {
  _setDb,
  _resetDb,
  createUser,
} from "../../src/db.js";
import { _clearBuckets } from "../../src/lib/ratelimit.js";
import { _clearIpBuckets } from "../../src/lib/rate-limit.js";
import { __resetKeyForTests } from "../../src/lib/crypto.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SID = "e".repeat(32);

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

async function get(path: string) {
  return app.request(path);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("integration: returning user — magic-link identity merged with GitHub", () => {
  let db: Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    process.env["TESTING"] = "1";
    process.env["GITHUB_CLIENT_ID"] = "test_id";
    process.env["GITHUB_CLIENT_SECRET"] = "test_secret";
    process.env["SITE_URL"] = "https://plugin.ashlr.ai";
    db = makeTestDb();
    _setDb(db);
    __resetKeyForTests();
    _clearBuckets();
    _clearIpBuckets();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetDb();
    __resetKeyForTests();
    _clearBuckets();
    _clearIpBuckets();
    delete process.env["TESTING"];
    delete process.env["GITHUB_CLIENT_ID"];
    delete process.env["GITHUB_CLIENT_SECRET"];
    delete process.env["SITE_URL"];
  });

  it("attaches github_id to existing magic-link user without creating a duplicate", async () => {
    // Seed: magic-link user — email row exists, no github_id
    const mlToken = "ml_" + "x".repeat(61);
    const existingUser = createUser("ml@example.com", mlToken);
    expect(existingUser.github_id).toBeNull();

    // Verify exactly one user row before OAuth
    const countBefore = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE email = 'ml@example.com'")
      .get();
    expect(countBefore!.n).toBe(1);

    // Get a valid signed state from /auth/github/start
    const startRes = await get(`/auth/github/start?sid=${VALID_SID}`);
    expect(startRes.status).toBe(302);
    const startUrl = new URL(startRes.headers.get("location") ?? "");
    const state = startUrl.searchParams.get("state") ?? "";

    // Stub GitHub to return the SAME email as the magic-link user
    globalThis.fetch = mock(async (url: string) => {
      const u = String(url);
      if (u.includes("login/oauth/access_token")) {
        return new Response(
          JSON.stringify({ access_token: "gho_merged", token_type: "bearer", scope: "read:user" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.endsWith("/user")) {
        return new Response(
          JSON.stringify({ id: 77001, login: "mluser", email: "ml@example.com", name: "ML User" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    // Callback — should merge, not create a new row
    const cbRes = await get(
      `/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(cbRes.status).toBe(302);

    // Exactly one user row with that email
    const countAfter = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE email = 'ml@example.com'")
      .get();
    expect(countAfter!.n).toBe(1);

    // github_id is now attached to the ORIGINAL user
    const user = db
      .query<{ id: string; github_id: string; github_login: string; github_access_token_encrypted: string }, []>(
        `SELECT id, github_id, github_login, github_access_token_encrypted FROM users WHERE email = 'ml@example.com'`,
      )
      .get();
    expect(user).not.toBeNull();
    expect(user!.id).toBe(existingUser.id);
    expect(user!.github_id).toBe("77001");
    expect(user!.github_login).toBe("mluser");
    expect(user!.github_access_token_encrypted).toBeTruthy();
  });
});
