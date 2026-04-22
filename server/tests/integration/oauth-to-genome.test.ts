/**
 * integration/oauth-to-genome.test.ts
 *
 * Full happy-path: GitHub OAuth → auth/status poll → genome build → genome find.
 * No real network, no real git — all outbound calls are stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import app from "../../src/index.js";
import {
  _setDb,
  _resetDb,
  getUserByGitHubId,
} from "../../src/db.js";
import { _clearBuckets } from "../../src/lib/ratelimit.js";
import { _clearIpBuckets } from "../../src/lib/rate-limit.js";
import { __resetKeyForTests } from "../../src/lib/crypto.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SID = "f".repeat(32);

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

async function get(path: string, headers: HeadersInit = {}) {
  return app.request(path, { headers });
}

async function post(path: string, body: unknown, headers: HeadersInit = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("integration: OAuth → genome build → genome find", () => {
  let db: Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    process.env["TESTING"] = "1";
    process.env["GITHUB_CLIENT_ID"] = "test_id";
    process.env["GITHUB_CLIENT_SECRET"] = "test_secret";
    process.env["SITE_URL"] = "https://plugin.ashlr.ai";
    process.env["BASE_URL"] = "https://api.ashlr.ai";
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
    delete process.env["BASE_URL"];
  });

  it("full happy path: start → callback → status → build → find", async () => {
    // 1. Start OAuth — should redirect to github.com
    const startRes = await get(`/auth/github/start?sid=${VALID_SID}`);
    expect(startRes.status).toBe(302);
    const location = startRes.headers.get("location") ?? "";
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test_id");
    expect(location).toContain("state=");

    // Extract the signed state parameter
    const authUrl = new URL(location);
    const state = authUrl.searchParams.get("state") ?? "";
    expect(state.startsWith(VALID_SID + ".")).toBe(true);

    // 2. Stub GitHub outbound calls for callback
    globalThis.fetch = mock(async (url: string) => {
      const u = String(url);
      if (u.includes("login/oauth/access_token")) {
        return new Response(
          JSON.stringify({
            access_token: "gho_test",
            scope: "read:user user:email public_repo",
            token_type: "bearer",
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.endsWith("/user")) {
        return new Response(
          JSON.stringify({ id: 99, login: "test-user", email: "test@example.com", name: "Test" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    // 3. Callback — should redirect to SITE_URL/auth/github/done?sid=...
    const callbackRes = await get(
      `/auth/github/callback?code=xyz&state=${encodeURIComponent(state)}`,
    );
    expect(callbackRes.status).toBe(302);
    const cbLocation = callbackRes.headers.get("location") ?? "";
    expect(cbLocation).toContain("plugin.ashlr.ai/auth/github/done");
    expect(cbLocation).toContain(`sid=${VALID_SID}`);

    // 4. Verify DB — user created with github_id and encrypted token
    const user = getUserByGitHubId("99");
    expect(user).not.toBeNull();
    expect(user!.github_login).toBe("test-user");
    expect(user!.github_access_token_encrypted).toBeTruthy();

    // 5. Poll /auth/status — should be ready with an apiToken
    const statusRes = await get(`/auth/status?session=${VALID_SID}`);
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json() as { ready: boolean; apiToken?: string };
    expect(statusBody.ready).toBe(true);
    expect(typeof statusBody.apiToken).toBe("string");
    expect(statusBody.apiToken!.length).toBeGreaterThan(0);

    const apiToken = statusBody.apiToken!;

    // 6. POST /genome/build — mock repo check + stub execFile
    globalThis.fetch = mock(async (url: string) => {
      const u = String(url);
      // Scope check — no `repo` scope so we need to serve the root API endpoint
      if (u === "https://api.github.com/") {
        return new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-oauth-scopes": "read:user, public_repo",
          },
        });
      }
      if (u.includes("api.github.com/repos/")) {
        return new Response(
          JSON.stringify({ private: false, name: "dotfiles" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    // Stub execFile so git clone never runs
    const childProcess = await import("node:child_process");
    const execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, { stdout: "", stderr: "" });
      }) as unknown as typeof childProcess.execFile,
    );

    const buildRes = await post(
      "/genome/build",
      { owner: "test-user", repo: "dotfiles" },
      { Authorization: `Bearer ${apiToken}` },
    );
    expect(buildRes.status).toBe(202);
    const buildBody = await buildRes.json() as { genomeId: string; status: string };
    expect(typeof buildBody.genomeId).toBe("string");
    expect(["queued", "ready"]).toContain(buildBody.status);

    execFileSpy.mockRestore();

    // 7. GET /genome/personal/find — should return the genome
    const findRes = await get(
      `/genome/personal/find?repo_url=https://github.com/test-user/dotfiles`,
      { Authorization: `Bearer ${apiToken}` },
    );
    expect(findRes.status).toBe(200);
    const findBody = await findRes.json() as { genomeId?: string; id?: string };
    const returnedId = findBody.genomeId ?? findBody.id;
    expect(returnedId).toBe(buildBody.genomeId);
  });
});
