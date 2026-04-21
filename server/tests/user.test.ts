/**
 * user.test.ts — /user/me + /user/repos endpoints.
 *
 * Covers the Phase 7B backend surface the repo-picker UI consumes. Stripe
 * isn't touched; GitHub API is mocked via fetch override.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";

import app from "../src/index.js";
import {
  _setDb,
  _resetDb,
  createUser,
  setUserTier,
  upsertGitHubIdentity,
} from "../src/db.js";
import { encrypt } from "../src/lib/crypto.js";

process.env["TESTING"] = "1";

let testDb: Database;

beforeEach(() => {
  testDb = new Database(":memory:");
  _setDb(testDb);
});

afterEach(() => {
  _resetDb();
  testDb.close();
});

function makeUser(opts: {
  email?: string;
  tier?: string;
  withGitHub?: boolean;
}) {
  const user = createUser(
    opts.email ?? "test@example.com",
    "tok_" + Math.random().toString(36).slice(2),
  );
  if (opts.tier && opts.tier !== "free") setUserTier(user.id, opts.tier);
  if (opts.withGitHub) {
    upsertGitHubIdentity({
      userId: user.id,
      githubId: "12345",
      githubLogin: "masonwyatt",
      encryptedAccessToken: encrypt("gho_testtoken_abc123"),
    });
  }
  return user;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// ---------------------------------------------------------------------------
// GET /user/me
// ---------------------------------------------------------------------------

describe("GET /user/me", () => {
  it("401 when unauthenticated", async () => {
    const res = await app.request("/user/me");
    expect(res.status).toBe(401);
  });

  it("returns the signed-in user's profile", async () => {
    const u = makeUser({ email: "me@example.com", tier: "pro", withGitHub: true });
    const res = await app.request("/user/me", { headers: authHeaders(u.api_token) });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      userId: string;
      email: string;
      tier: string;
      githubLogin: string | null;
      hasGitHub: boolean;
    };
    expect(body.userId).toBe(u.id);
    expect(body.email).toBe("me@example.com");
    expect(body.tier).toBe("pro");
    expect(body.githubLogin).toBe("masonwyatt");
    expect(body.hasGitHub).toBe(true);
  });

  it("hasGitHub=false for magic-link-only users", async () => {
    const u = makeUser({ email: "magic@example.com" });
    const res = await app.request("/user/me", { headers: authHeaders(u.api_token) });
    const body = await res.json() as { hasGitHub: boolean; githubLogin: string | null };
    expect(body.hasGitHub).toBe(false);
    expect(body.githubLogin).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /user/repos
// ---------------------------------------------------------------------------

describe("GET /user/repos", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(status: number, body: unknown) {
    globalThis.fetch = mock(async () => new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
  }

  it("401 when unauthenticated", async () => {
    const res = await app.request("/user/repos");
    expect(res.status).toBe(401);
  });

  it("400 when user has no GitHub identity linked", async () => {
    const u = makeUser({ email: "noghub@example.com" });
    const res = await app.request("/user/repos", { headers: authHeaders(u.api_token) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/no GitHub identity/i);
  });

  it("returns trimmed repo shape for the signed-in user", async () => {
    const u = makeUser({ email: "gh@example.com", withGitHub: true });
    mockFetch(200, [
      {
        full_name: "masonwyatt/ashlr-plugin",
        name: "ashlr-plugin",
        owner: { login: "masonwyatt" },
        description: "the plugin",
        stargazers_count: 42,
        pushed_at: "2026-04-20T12:00:00Z",
        private: false,
        html_url: "https://github.com/masonwyatt/ashlr-plugin",
      },
    ]);
    const res = await app.request("/user/repos", { headers: authHeaders(u.api_token) });
    expect(res.status).toBe(200);
    const repos = await res.json() as Array<{
      owner: string;
      name: string;
      description: string;
      stars: number;
      visibility: "public" | "private";
      htmlUrl: string;
    }>;
    expect(repos.length).toBe(1);
    expect(repos[0]!.owner).toBe("masonwyatt");
    expect(repos[0]!.name).toBe("ashlr-plugin");
    expect(repos[0]!.stars).toBe(42);
    expect(repos[0]!.visibility).toBe("public");
  });

  it("free tier sees only public visibility", async () => {
    const u = makeUser({ email: "free@example.com", tier: "free", withGitHub: true });
    let capturedUrl = "";
    globalThis.fetch = mock(async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await app.request("/user/repos", { headers: authHeaders(u.api_token) });
    expect(capturedUrl).toContain("visibility=public");
  });

  it("pro tier sees all visibility", async () => {
    const u = makeUser({ email: "pro@example.com", tier: "pro", withGitHub: true });
    let capturedUrl = "";
    globalThis.fetch = mock(async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await app.request("/user/repos", { headers: authHeaders(u.api_token) });
    expect(capturedUrl).toContain("visibility=all");
  });

  it("forwards GitHub API error status to caller", async () => {
    const u = makeUser({ email: "err@example.com", withGitHub: true });
    mockFetch(401, { message: "Bad credentials" });
    const res = await app.request("/user/repos", { headers: authHeaders(u.api_token) });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("401");
  });
});
