/**
 * integration/scope-up-to-private-build.test.ts
 *
 * Phase 7C scope-up happy path:
 *   1. Pro user with public_repo scope attempts private genome build → 403 scope_up_required
 *   2. /auth/github/scope-up → 302 to GitHub with full `repo` scope
 *   3. Scope-up callback overwrites the encrypted token in DB
 *   4. Second build attempt with repo scope → 202
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../../src/index.js";
import {
  _setDb,
  _resetDb,
  createUser,
  setUserTier,
  upsertGitHubIdentity,
  getDb,
} from "../../src/db.js";
import { _clearBuckets } from "../../src/lib/ratelimit.js";
import { __resetKeyForTests, encrypt } from "../../src/lib/crypto.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SID = "d".repeat(32);

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

async function getReq(path: string, headers: HeadersInit = {}) {
  return app.request(path, { headers });
}

async function postReq(path: string, body: unknown, headers: HeadersInit = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function makeFetchForScope(hasRepoScope: boolean, isPrivate: boolean) {
  return mock(async (url: string) => {
    const u = String(url);
    if (u === "https://api.github.com/") {
      return new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-oauth-scopes": hasRepoScope
            ? "read:user, public_repo, repo"
            : "read:user, public_repo",
        },
      });
    }
    if (u.includes("api.github.com/repos/")) {
      return new Response(
        JSON.stringify({ private: isPrivate, name: "private-repo" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("integration: scope-up → private genome build", () => {
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
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetDb();
    __resetKeyForTests();
    _clearBuckets();
    delete process.env["TESTING"];
    delete process.env["GITHUB_CLIENT_ID"];
    delete process.env["GITHUB_CLIENT_SECRET"];
    delete process.env["SITE_URL"];
  });

  it("scope-up flow: 403 → scope-up redirect → callback overwrites token → 202 build", async () => {
    // Seed pro user with public_repo-only GitHub token
    const token = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
    const user = createUser("scopeup-int@example.com", token);
    setUserTier(user.id, "pro");

    const oldEncryptedToken = encrypt("gho_public_only");
    upsertGitHubIdentity({
      userId: user.id,
      githubId: "55555",
      githubLogin: "scopeupuser",
      encryptedAccessToken: oldEncryptedToken,
    });

    // Step 1: build private repo → 403 scope_up_required
    globalThis.fetch = makeFetchForScope(false, true) as unknown as typeof globalThis.fetch;

    const build1 = await postReq(
      "/genome/build",
      { owner: "scopeupuser", repo: "private-repo" },
      authHeaders(token),
    );
    expect(build1.status).toBe(403);
    const build1Body = await build1.json() as { error_code: string; scope_up_url: string };
    expect(build1Body.error_code).toBe("scope_up_required");
    expect(build1Body.scope_up_url).toBeTruthy();

    // Step 2: GET /auth/github/scope-up → 302 with repo scope
    const scopeUpRes = await getReq(
      `/auth/github/scope-up?sid=${VALID_SID}`,
      authHeaders(token),
    );
    expect(scopeUpRes.status).toBe(302);
    const scopeUpLocation = scopeUpRes.headers.get("location") ?? "";
    expect(scopeUpLocation).toContain("github.com/login/oauth/authorize");
    const scopeUpUrl = new URL(scopeUpLocation);
    const scope = scopeUpUrl.searchParams.get("scope") ?? "";
    expect(scope).toContain("repo");
    expect(scope).toContain("public_repo");

    // Extract state for callback
    const scopeUpState = scopeUpUrl.searchParams.get("state") ?? "";
    expect(scopeUpState.startsWith(VALID_SID + ".")).toBe(true);

    // Step 3: scope-up callback — mock GitHub to return upgraded token with SAME github id
    globalThis.fetch = mock(async (url: string) => {
      const u = String(url);
      if (u.includes("access_token")) {
        return new Response(
          JSON.stringify({ access_token: "gho_upgraded", token_type: "bearer" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.endsWith("/user")) {
        return new Response(
          JSON.stringify({ id: 55555, login: "scopeupuser", email: "scopeup-int@example.com" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const callbackRes = await getReq(
      `/auth/github/scope-up/callback?code=upgraded_code&state=${encodeURIComponent(scopeUpState)}`,
    );
    expect(callbackRes.status).toBe(302);
    const callbackLocation = callbackRes.headers.get("location") ?? "";
    expect(callbackLocation).toContain("scope-up/done");

    // Encrypted token in DB must have changed
    const tokenRow = db
      .query<{ github_access_token_encrypted: string }, [string]>(
        "SELECT github_access_token_encrypted FROM users WHERE id = ?",
      )
      .get(user.id);
    expect(tokenRow?.github_access_token_encrypted).toBeTruthy();
    expect(tokenRow!.github_access_token_encrypted).not.toBe(oldEncryptedToken);

    // Verify the new token decrypts to the upgraded value
    const { decrypt } = await import("../../src/lib/crypto.js");
    expect(decrypt(tokenRow!.github_access_token_encrypted)).toBe("gho_upgraded");

    // Step 4: re-attempt build — now mock upgraded scope + private repo
    globalThis.fetch = makeFetchForScope(true, true) as unknown as typeof globalThis.fetch;

    // Stub execFile for the actual clone step
    const childProcess = await import("node:child_process");
    const execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, { stdout: "", stderr: "" });
      }) as unknown as typeof childProcess.execFile,
    );

    const build2 = await postReq(
      "/genome/build",
      { owner: "scopeupuser", repo: "private-repo" },
      authHeaders(token),
    );
    expect(build2.status).toBe(202);

    execFileSpy.mockRestore();
  });
});
