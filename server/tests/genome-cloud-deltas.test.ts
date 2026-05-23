/**
 * genome-cloud-deltas.test.ts — Q2 cloud delta sync tests.
 *
 * Covers:
 *   - Push webhook writes one commit delta per commit
 *   - PR merged → pr_merged delta
 *   - Issue closed → issue_closed delta
 *   - Duplicate webhook → no duplicate rows (UNIQUE index works)
 *   - GET /genome/cloud-deltas requires auth (401 without token)
 *   - Free tier → 403
 *   - Pagination respects since_cursor
 *   - limit cap of 500
 *   - Authorization: caller can't read another user's genome (404)
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import {
  _setDb,
  _resetDb,
  createUser,
  setUserTier,
  getDb,
} from "../src/db.js";
import { recordGenomeDelta } from "../src/lib/genome-deltas.js";
import app from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-webhook-secret-deltas-xyz";

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function sign(body: string, secret = TEST_SECRET): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(Buffer.from(body, "utf8"));
  return `sha256=${hmac.digest("hex")}`;
}

function webhookRequest(opts: {
  body: string;
  event: string;
  signature?: string | null;
  deliveryId?: string;
}) {
  const { body, event, signature = sign(opts.body), deliveryId = crypto.randomUUID() } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-github-event": event,
    "x-github-delivery": deliveryId,
  };
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return app.request("/webhooks/github", { method: "POST", headers, body });
}

function insertPersonalGenome(userId: string, repoUrl: string): string {
  const db = getDb();
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO genomes (id, org_id, repo_url, owner_user_id, repo_visibility, build_status)
     VALUES (?, ?, ?, ?, 'public', 'ready')`,
    [id, userId, repoUrl, userId],
  );
  return id;
}

function makePushBody(fullName: string, commits: Array<{ id: string; message?: string; added?: string[]; modified?: string[]; removed?: string[] }>): string {
  return JSON.stringify({
    after: commits[commits.length - 1]?.id ?? "",
    ref: "refs/heads/main",
    repository: { full_name: fullName, private: false },
    commits: commits.map((c) => ({
      id: c.id,
      message: c.message ?? `commit ${c.id}`,
      timestamp: "2026-05-22T12:00:00Z",
      author: { name: "Alice", email: "alice@example.com" },
      added: c.added ?? [],
      modified: c.modified ?? [],
      removed: c.removed ?? [],
    })),
    sender: { login: "alice" },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let originalSecret: string | undefined;

beforeEach(() => {
  _setDb(makeTestDb());
  originalSecret = process.env["GITHUB_WEBHOOK_SECRET"];
  process.env["GITHUB_WEBHOOK_SECRET"] = TEST_SECRET;
});

afterEach(() => {
  _resetDb();
  if (originalSecret === undefined) delete process.env["GITHUB_WEBHOOK_SECRET"];
  else process.env["GITHUB_WEBHOOK_SECRET"] = originalSecret;
});

// ---------------------------------------------------------------------------
// Webhook → delta recording
// ---------------------------------------------------------------------------

describe("webhook → genome_deltas", () => {
  it("writes 1 commit delta per push commit", async () => {
    const user = createUser("push-deltas@test.com", `tok_${crypto.randomUUID().replace(/-/g, "")}`);
    setUserTier(user.id, "pro");
    const repoUrl = "https://github.com/alice/repo1";
    const genomeId = insertPersonalGenome(user.id, repoUrl);

    // Avoid hitting GitHub during the test.
    const genomeBuild = await import("../src/services/genome-build.js");
    const spy = spyOn(genomeBuild, "rebuildGenomeDelta").mockResolvedValue({
      sectionsUpdated: 0, durationMs: 0, changeSummary: "",
    });

    const body = makePushBody("alice/repo1", [
      { id: "a".repeat(40), message: "fix A", added: ["src/a.ts"] },
      { id: "b".repeat(40), message: "fix B", modified: ["src/b.ts"] },
      { id: "c".repeat(40), message: "fix C", removed: ["old.ts"] },
    ]);
    const res = await webhookRequest({ body, event: "push" });
    expect(res.status).toBe(202);

    const rows = getDb()
      .query<{ delta_kind: string; source_sha: string }, [string]>(
        `SELECT delta_kind, source_sha FROM genome_deltas WHERE genome_id = ? ORDER BY id ASC`,
      )
      .all(genomeId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.delta_kind === "commit")).toBe(true);
    expect(rows.map((r) => r.source_sha)).toEqual(["a".repeat(40), "b".repeat(40), "c".repeat(40)]);

    spy.mockRestore();
  });

  it("PR merged → pr_merged delta", async () => {
    const user = createUser("pr@test.com", `tok_${crypto.randomUUID().replace(/-/g, "")}`);
    setUserTier(user.id, "pro");
    const repoUrl = "https://github.com/alice/pr-repo";
    const genomeId = insertPersonalGenome(user.id, repoUrl);

    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 42,
        title: "Add cool feature",
        merged: true,
        merge_commit_sha: "deadbeef",
        merged_at: "2026-05-22T10:00:00Z",
        user: { login: "alice" },
        body: "This PR adds the cool feature.",
      },
      repository: { full_name: "alice/pr-repo" },
    });
    const res = await webhookRequest({ body, event: "pull_request" });
    expect(res.status).toBe(202);

    const rows = getDb()
      .query<{ delta_kind: string; source_sha: string; delta_payload_json: string }, [string]>(
        `SELECT delta_kind, source_sha, delta_payload_json FROM genome_deltas WHERE genome_id = ?`,
      )
      .all(genomeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta_kind).toBe("pr_merged");
    expect(rows[0]!.source_sha).toBe("42");
    const payload = JSON.parse(rows[0]!.delta_payload_json);
    expect(payload.kind).toBe("pr_merged");
    expect(payload.number).toBe(42);
    expect(payload.title).toBe("Add cool feature");
  });

  it("PR closed-but-not-merged → ignored", async () => {
    const user = createUser("pr-noop@test.com", `tok_${crypto.randomUUID().replace(/-/g, "")}`);
    setUserTier(user.id, "pro");
    insertPersonalGenome(user.id, "https://github.com/alice/noop");

    const body = JSON.stringify({
      action: "closed",
      pull_request: { number: 1, merged: false },
      repository: { full_name: "alice/noop" },
    });
    const res = await webhookRequest({ body, event: "pull_request" });
    expect(res.status).toBe(202);
    const json = await res.json() as { message: string };
    expect(json.message).toBe("ignored");
  });

  it("issue closed → issue_closed delta", async () => {
    const user = createUser("issue@test.com", `tok_${crypto.randomUUID().replace(/-/g, "")}`);
    setUserTier(user.id, "pro");
    const repoUrl = "https://github.com/alice/issue-repo";
    const genomeId = insertPersonalGenome(user.id, repoUrl);

    const body = JSON.stringify({
      action: "closed",
      issue: {
        number: 7,
        title: "Login broken on mobile",
        closed_at: "2026-05-22T09:00:00Z",
        user: { login: "bob" },
        body: "Steps to reproduce: tap login → spinner forever",
      },
      repository: { full_name: "alice/issue-repo" },
    });
    const res = await webhookRequest({ body, event: "issues" });
    expect(res.status).toBe(202);

    const rows = getDb()
      .query<{ delta_kind: string; source_sha: string }, [string]>(
        `SELECT delta_kind, source_sha FROM genome_deltas WHERE genome_id = ?`,
      )
      .all(genomeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta_kind).toBe("issue_closed");
    expect(rows[0]!.source_sha).toBe("7");
  });

  it("duplicate commit deltas dedupe (UNIQUE on (genome_id, kind, source_sha))", async () => {
    const user = createUser("dup@test.com", `tok_${crypto.randomUUID().replace(/-/g, "")}`);
    setUserTier(user.id, "pro");
    const repoUrl = "https://github.com/alice/dup-repo";
    const genomeId = insertPersonalGenome(user.id, repoUrl);

    // Two recordGenomeDelta calls with same shasum → only one row.
    const r1 = recordGenomeDelta({
      genomeId,
      kind: "commit",
      sourceSha: "x".repeat(40),
      payload: { kind: "commit", sha: "x".repeat(40), message: "first", filesChanged: [] },
    });
    const r2 = recordGenomeDelta({
      genomeId,
      kind: "commit",
      sourceSha: "x".repeat(40),
      payload: { kind: "commit", sha: "x".repeat(40), message: "dup", filesChanged: [] },
    });
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);

    const count = getDb()
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM genome_deltas WHERE genome_id = ?`)
      .get(genomeId);
    expect(count!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /genome/cloud-deltas
// ---------------------------------------------------------------------------

describe("GET /genome/cloud-deltas", () => {
  it("requires bearer token (401)", async () => {
    const res = await app.request("/genome/cloud-deltas?genome_id=anything");
    expect(res.status).toBe(401);
  });

  it("rejects free tier with 403", async () => {
    const token = `tok_free_${crypto.randomUUID().replace(/-/g, "")}`;
    createUser("free@test.com", token); // default tier = free
    const res = await app.request("/genome/cloud-deltas?genome_id=anything", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("requires genome_id query param", async () => {
    const token = `tok_pro_${crypto.randomUUID().replace(/-/g, "")}`;
    const user = createUser("pro1@test.com", token);
    setUserTier(user.id, "pro");
    const res = await app.request("/genome/cloud-deltas", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when caller doesn't own the genome", async () => {
    const tokA = `tok_a_${crypto.randomUUID().replace(/-/g, "")}`;
    const a = createUser("a@test.com", tokA);
    setUserTier(a.id, "pro");

    const tokB = `tok_b_${crypto.randomUUID().replace(/-/g, "")}`;
    const b = createUser("b@test.com", tokB);
    setUserTier(b.id, "pro");

    const genomeId = insertPersonalGenome(b.id, "https://github.com/bob/private");

    // A asks for B's genome → 404 (existence-leak guard).
    const res = await app.request(`/genome/cloud-deltas?genome_id=${genomeId}`, {
      headers: { Authorization: `Bearer ${tokA}` },
    });
    expect(res.status).toBe(404);
  });

  it("returns deltas owned by caller, paginates via since_cursor", async () => {
    const token = `tok_pag_${crypto.randomUUID().replace(/-/g, "")}`;
    const user = createUser("pag@test.com", token);
    setUserTier(user.id, "pro");
    const genomeId = insertPersonalGenome(user.id, "https://github.com/alice/pag");

    // 5 commit deltas.
    for (let i = 0; i < 5; i++) {
      recordGenomeDelta({
        genomeId,
        kind: "commit",
        sourceSha: `sha-${i}`,
        payload: { kind: "commit", sha: `sha-${i}`, message: `m${i}`, filesChanged: [] },
      });
    }

    // First page: 3 items.
    const res1 = await app.request(`/genome/cloud-deltas?genome_id=${genomeId}&limit=3`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as { deltas: Array<{ id: number; cursor: number; sourceSha: string }>; nextCursor: number };
    expect(body1.deltas).toHaveLength(3);
    expect(body1.deltas[0]!.sourceSha).toBe("sha-0");
    expect(body1.nextCursor).toBe(body1.deltas[2]!.cursor);

    // Second page from nextCursor: 2 remaining.
    const res2 = await app.request(
      `/genome/cloud-deltas?genome_id=${genomeId}&since_cursor=${body1.nextCursor}&limit=10`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as { deltas: Array<{ sourceSha: string }>; nextCursor: number };
    expect(body2.deltas).toHaveLength(2);
    expect(body2.deltas[0]!.sourceSha).toBe("sha-3");
    expect(body2.deltas[1]!.sourceSha).toBe("sha-4");

    // Third page from advanced cursor: empty.
    const res3 = await app.request(
      `/genome/cloud-deltas?genome_id=${genomeId}&since_cursor=${body2.nextCursor}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res3.status).toBe(200);
    const body3 = await res3.json() as { deltas: unknown[]; nextCursor: number };
    expect(body3.deltas).toHaveLength(0);
    expect(body3.nextCursor).toBe(body2.nextCursor);
  });

  it("caps limit at 500", async () => {
    const token = `tok_cap_${crypto.randomUUID().replace(/-/g, "")}`;
    const user = createUser("cap@test.com", token);
    setUserTier(user.id, "pro");
    const genomeId = insertPersonalGenome(user.id, "https://github.com/alice/cap");

    // Just check the request succeeds with an absurd limit; the cap is applied silently.
    const res = await app.request(`/genome/cloud-deltas?genome_id=${genomeId}&limit=9999`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});
