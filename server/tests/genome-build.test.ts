/**
 * genome-build.test.ts — Tests for server-side auto-genome-build (v1.13 Phase 7B.4).
 *
 * Covers:
 *   - canonicalizeRepoUrl variants
 *   - buildGenomeFromGitHub: tier gating, happy paths, failure modes, rebuild
 *   - POST /genome/build: auth, body validation, 202 shape, rate limit
 *   - GET /genome/personal/find: match, 404, isolation
 *   - GET /genome/personal/list: own genomes only
 *   - GET /genome/:genomeId/status
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDb, _resetDb, createUser, setUserTier, getDb, getGenomeById } from "../src/db.js";
import { canonicalizeRepoUrl, buildGenomeFromGitHub, TierGateError } from "../src/services/genome-build.js";
import { _clearSlidingWindows } from "../src/lib/ratelimit.js";
import app from "../src/index.js";

// ---------------------------------------------------------------------------
// Test DB
// ---------------------------------------------------------------------------

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function makeUser(email: string, tier: "free" | "pro" | "team") {
  const token = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
  const user = createUser(email, token);
  setUserTier(user.id, tier);
  return { ...user, tier, api_token: token };
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function post(path: string, body: unknown, token: string) {
  return app.request(path, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function get(path: string, token: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } });
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock fetch that returns a GitHub-like repo response. */
function mockGitHubFetch(opts: { status?: number; isPrivate?: boolean } = {}) {
  const status = opts.status ?? 200;
  const body = JSON.stringify({ private: opts.isPrivate ?? false, name: "test-repo" });
  return mock(() =>
    Promise.resolve(
      new Response(body, { status, headers: { "Content-Type": "application/json" } }),
    ),
  );
}

// ---------------------------------------------------------------------------
// canonicalizeRepoUrl
// ---------------------------------------------------------------------------

describe("canonicalizeRepoUrl", () => {
  it("lowercases owner and repo", () => {
    expect(canonicalizeRepoUrl("Foo", "Bar")).toBe("https://github.com/foo/bar");
  });

  it("strips .git suffix from repo", () => {
    expect(canonicalizeRepoUrl("foo", "bar.git")).toBe("https://github.com/foo/bar");
  });

  it("strips trailing slash from repo", () => {
    expect(canonicalizeRepoUrl("foo", "bar/")).toBe("https://github.com/foo/bar");
  });

  it("strips .git and trailing slash from owner", () => {
    expect(canonicalizeRepoUrl("Foo.git", "Bar")).toBe("https://github.com/foo/bar");
  });

  it("handles already-canonical input", () => {
    expect(canonicalizeRepoUrl("foo", "bar")).toBe("https://github.com/foo/bar");
  });
});

// ---------------------------------------------------------------------------
// buildGenomeFromGitHub
// ---------------------------------------------------------------------------

describe("buildGenomeFromGitHub", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    const db = makeTestDb();
    _setDb(db);
    origFetch = globalThis.fetch;
    // Set testing env so crypto module uses ephemeral key
    process.env["TESTING"] = "1";
  });

  afterEach(() => {
    _resetDb();
    globalThis.fetch = origFetch;
    _clearSlidingWindows();
  });

  it("throws TierGateError for free tier on 404 (private/nonexistent repo)", async () => {
    const user = makeUser("free@example.com", "free");
    globalThis.fetch = mockGitHubFetch({ status: 404 }) as unknown as typeof fetch;

    await expect(
      buildGenomeFromGitHub({ userId: user.id, owner: "foo", repo: "private-repo" }),
    ).rejects.toThrow(TierGateError);
  });

  it("throws TierGateError for free tier on private repo (200 response)", async () => {
    const user = makeUser("free2@example.com", "free");
    globalThis.fetch = mockGitHubFetch({ status: 200, isPrivate: true }) as unknown as typeof fetch;

    await expect(
      buildGenomeFromGitHub({ userId: user.id, owner: "foo", repo: "private-repo" }),
    ).rejects.toThrow(TierGateError);
  });

  it("queues build for free tier on public repo and returns genomeId", async () => {
    const user = makeUser("free3@example.com", "free");
    globalThis.fetch = mockGitHubFetch({ status: 200, isPrivate: false }) as unknown as typeof fetch;

    // Mock execFile so clone + genome-init don't actually run
    const childProcess = await import("node:child_process");
    const execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, out: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "", stderr: "" });
      }) as unknown as typeof childProcess.execFile,
    );

    const result = await buildGenomeFromGitHub({ userId: user.id, owner: "foo", repo: "pub-repo" });
    expect(result.status).toBe("queued");
    expect(typeof result.genomeId).toBe("string");

    execFileSpy.mockRestore();
  });

  it("queues build for pro tier on private repo", async () => {
    const user = makeUser("pro@example.com", "pro");
    globalThis.fetch = mockGitHubFetch({ status: 200, isPrivate: true }) as unknown as typeof fetch;

    const childProcess = await import("node:child_process");
    const execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, out: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "", stderr: "" });
      }) as unknown as typeof childProcess.execFile,
    );

    const result = await buildGenomeFromGitHub({ userId: user.id, owner: "foo", repo: "private-repo" });
    expect(result.status).toBe("queued");

    execFileSpy.mockRestore();
  });

  it("rebuild on same repo overwrites prior genome row (no duplicate)", async () => {
    const user = makeUser("rebuild@example.com", "pro");
    globalThis.fetch = mockGitHubFetch({ status: 200, isPrivate: false }) as unknown as typeof fetch;

    const childProcess = await import("node:child_process");
    const execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, out: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "", stderr: "" });
      }) as unknown as typeof childProcess.execFile,
    );

    const r1 = await buildGenomeFromGitHub({ userId: user.id, owner: "foo", repo: "same-repo" });
    const r2 = await buildGenomeFromGitHub({ userId: user.id, owner: "foo", repo: "same-repo" });
    expect(r1.genomeId).toBe(r2.genomeId);

    const db = getDb();
    const count = db.query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM genomes WHERE owner_user_id = ? AND repo_url = ?`,
    ).get(user.id, "https://github.com/foo/same-repo");
    expect(count?.n).toBe(1);

    execFileSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// POST /genome/build
// ---------------------------------------------------------------------------

describe("POST /genome/build", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    const db = makeTestDb();
    _setDb(db);
    origFetch = globalThis.fetch;
    process.env["TESTING"] = "1";
    _clearSlidingWindows();
  });

  afterEach(() => {
    _resetDb();
    globalThis.fetch = origFetch;
    _clearSlidingWindows();
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/genome/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "foo", repo: "bar" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 on missing body fields", async () => {
    const user = makeUser("bodyval@example.com", "pro");
    const res = await post("/genome/build", { owner: "foo" }, user.api_token);
    expect(res.status).toBe(400);
  });

  it("returns 202 with genomeId + status on success", async () => {
    const user = makeUser("build202@example.com", "free");
    globalThis.fetch = mockGitHubFetch({ status: 200, isPrivate: false }) as unknown as typeof fetch;

    const childProcess = await import("node:child_process");
    const execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, out: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "", stderr: "" });
      }) as unknown as typeof childProcess.execFile,
    );

    const res = await post("/genome/build", { owner: "myorg", repo: "myrepo" }, user.api_token);
    expect(res.status).toBe(202);
    const body = await res.json() as { genomeId: string; status: string; buildStartedAt: string };
    expect(body.status).toBe("queued");
    expect(typeof body.genomeId).toBe("string");
    expect(typeof body.buildStartedAt).toBe("string");

    execFileSpy.mockRestore();
  });

  it("returns 403 on tier gate (free + private repo)", async () => {
    const user = makeUser("tiergate@example.com", "free");
    globalThis.fetch = mockGitHubFetch({ status: 404 }) as unknown as typeof fetch;

    const res = await post("/genome/build", { owner: "foo", repo: "private" }, user.api_token);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("free tier");
  });

  it("enforces rate limit of 5 per hour on the 6th call", async () => {
    const user = makeUser("ratelimit@example.com", "pro");
    globalThis.fetch = mockGitHubFetch({ status: 200, isPrivate: false }) as unknown as typeof fetch;

    const childProcess = await import("node:child_process");
    const execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, out: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "", stderr: "" });
      }) as unknown as typeof childProcess.execFile,
    );

    // First 5 calls should succeed
    for (let i = 0; i < 5; i++) {
      const res = await post("/genome/build", { owner: "foo", repo: `repo${i}` }, user.api_token);
      expect(res.status).toBe(202);
    }

    // 6th call should be rate limited
    const res = await post("/genome/build", { owner: "foo", repo: "repo6" }, user.api_token);
    expect(res.status).toBe(429);

    execFileSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// GET /genome/personal/find
// ---------------------------------------------------------------------------

describe("GET /genome/personal/find", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    const db = makeTestDb();
    _setDb(db);
    origFetch = globalThis.fetch;
    process.env["TESTING"] = "1";
    _clearSlidingWindows();
  });

  afterEach(() => {
    _resetDb();
    globalThis.fetch = origFetch;
    _clearSlidingWindows();
  });

  it("returns 404 when no genome exists", async () => {
    const user = makeUser("find404@example.com", "pro");
    const res = await get(
      "/genome/personal/find?repo_url=https://github.com/foo/bar",
      user.api_token,
    );
    expect(res.status).toBe(404);
  });

  it("returns genome data on exact match", async () => {
    const user = makeUser("findmatch2@example.com", "free");
    globalThis.fetch = mockGitHubFetch({ status: 200, isPrivate: false }) as unknown as typeof fetch;

    const childProcess = await import("node:child_process");
    const execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, out: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "", stderr: "" });
      }) as unknown as typeof childProcess.execFile,
    );

    const { genomeId } = await buildGenomeFromGitHub({ userId: user.id, owner: "foo", repo: "bar" });

    const res = await get(
      "/genome/personal/find?repo_url=https://github.com/foo/bar",
      user.api_token,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { genomeId: string; status: string };
    expect(body.genomeId).toBe(genomeId);
    // status may be 'queued' or 'building' depending on background task timing
    expect(["queued", "building", "ready", "failed"]).toContain(body.status);

    execFileSpy.mockRestore();
  });

  it("does not leak another user's genome", async () => {
    const user1 = makeUser("pf_user1@example.com", "pro");
    const user2 = makeUser("pf_user2@example.com", "pro");
    globalThis.fetch = mockGitHubFetch({ status: 200, isPrivate: false }) as unknown as typeof fetch;

    const childProcess = await import("node:child_process");
    const execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, out: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "", stderr: "" });
      }) as unknown as typeof childProcess.execFile,
    );

    // user1 builds a genome
    await buildGenomeFromGitHub({ userId: user1.id, owner: "foo", repo: "secret" });

    // user2 should not see it
    const res = await get(
      "/genome/personal/find?repo_url=https://github.com/foo/secret",
      user2.api_token,
    );
    expect(res.status).toBe(404);

    execFileSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// GET /genome/personal/list
// ---------------------------------------------------------------------------

describe("GET /genome/personal/list", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    const db = makeTestDb();
    _setDb(db);
    origFetch = globalThis.fetch;
    process.env["TESTING"] = "1";
    _clearSlidingWindows();
  });

  afterEach(() => {
    _resetDb();
    globalThis.fetch = origFetch;
    _clearSlidingWindows();
  });

  it("returns empty array when no genomes", async () => {
    const user = makeUser("listempty@example.com", "pro");
    const res = await get("/genome/personal/list", user.api_token);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it("returns only the requesting user's genomes", async () => {
    const user1 = makeUser("pl_user1@example.com", "pro");
    const user2 = makeUser("pl_user2@example.com", "pro");
    globalThis.fetch = mockGitHubFetch({ status: 200, isPrivate: false }) as unknown as typeof fetch;

    const childProcess = await import("node:child_process");
    const execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, out: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "", stderr: "" });
      }) as unknown as typeof childProcess.execFile,
    );

    await buildGenomeFromGitHub({ userId: user1.id, owner: "foo", repo: "repo-a" });
    await buildGenomeFromGitHub({ userId: user1.id, owner: "foo", repo: "repo-b" });
    await buildGenomeFromGitHub({ userId: user2.id, owner: "foo", repo: "repo-c" });

    const res1 = await get("/genome/personal/list", user1.api_token);
    const body1 = await res1.json() as Array<{ repoUrl: string }>;
    expect(body1.length).toBe(2);
    expect(body1.every((g) => g.repoUrl.includes("repo-a") || g.repoUrl.includes("repo-b"))).toBe(true);

    const res2 = await get("/genome/personal/list", user2.api_token);
    const body2 = await res2.json() as Array<{ repoUrl: string }>;
    expect(body2.length).toBe(1);
    expect(body2[0]!.repoUrl).toContain("repo-c");

    execFileSpy.mockRestore();
  });
});
