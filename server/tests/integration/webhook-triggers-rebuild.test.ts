/**
 * integration/webhook-triggers-rebuild.test.ts
 *
 * GitHub push webhook round-trip:
 *   - HMAC signature verification
 *   - DB row written with status "received"
 *   - Replay protection (duplicate delivery id)
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import app from "../../src/index.js";
import {
  _setDb,
  _resetDb,
  createUser,
  setUserTier,
  hasProcessedDelivery,
  getDb,
} from "../../src/db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "test_webhook_secret";

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function sign(body: string, secret = WEBHOOK_SECRET): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(Buffer.from(body, "utf8"));
  return `sha256=${hmac.digest("hex")}`;
}

function makePushPayload(fullName: string, sha = "deadbeef12345678"): string {
  return JSON.stringify({
    after: sha,
    ref: "refs/heads/main",
    repository: { full_name: fullName, private: false },
    commits: [{ id: sha, added: ["README.md"], modified: [], removed: [] }],
    sender: { login: "pusher" },
  });
}

function webhookReq(opts: {
  body: string;
  deliveryId?: string;
  event?: string;
  signature?: string | null;
}) {
  const {
    body,
    deliveryId = crypto.randomUUID(),
    event = "push",
    signature = sign(body),
  } = opts;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-github-event": event,
    "x-github-delivery": deliveryId,
  };
  if (signature !== null) headers["x-hub-signature-256"] = signature;

  return { res: app.request("/webhooks/github", { method: "POST", headers, body }), deliveryId };
}

function seedPersonalGenome(userId: string, repoUrl: string): string {
  const id = crypto.randomUUID();
  getDb().run(
    `INSERT INTO genomes (id, org_id, repo_url, owner_user_id, repo_visibility, build_status)
     VALUES (?, ?, ?, ?, 'public', 'ready')`,
    [id, userId, repoUrl, userId],
  );
  return id;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("integration: webhook push → rebuild → replay protection", () => {
  beforeEach(() => {
    _setDb(makeTestDb());
    process.env["GITHUB_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  });

  afterEach(() => {
    _resetDb();
    delete process.env["GITHUB_WEBHOOK_SECRET"];
  });

  it("happy path: 202, DB row written, replay returns already-processed", async () => {
    // Seed user + personal genome
    const token = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
    const user = createUser("webhooktest@example.com", token);
    setUserTier(user.id, "pro");
    const repoUrl = "https://github.com/test/repo";
    seedPersonalGenome(user.id, repoUrl);

    // Stub genome rebuild service — no real git
    const genomeBuild = await import("../../src/services/genome-build.js");
    const rebuildSpy = spyOn(genomeBuild, "rebuildGenomeDelta").mockResolvedValue({
      sectionsUpdated: 2,
      durationMs: 50,
      changeSummary: "1 file(s) changed: README.md",
    });

    const deliveryId = crypto.randomUUID();
    const body = makePushPayload("test/repo");

    // First delivery — should succeed
    const { res: res1 } = webhookReq({ body, deliveryId });
    const response1 = await res1;
    expect(response1.status).toBe(202);
    const json1 = await response1.json() as { message: string };
    expect(json1.message).toBe("queued");

    // DB row recorded
    expect(hasProcessedDelivery(deliveryId)).toBe(true);

    // Replay — same delivery id
    const { res: res2 } = webhookReq({ body, deliveryId });
    const response2 = await res2;
    expect(response2.status).toBe(200);
    const json2 = await response2.json() as { message: string };
    expect(json2.message).toBe("already processed");

    // No duplicate row
    const count = getDb()
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM webhook_events WHERE id = ?")
      .get(deliveryId);
    expect(count!.n).toBe(1);

    rebuildSpy.mockRestore();
  });

  it("missing signature → 401", async () => {
    const body = makePushPayload("test/repo");
    const { res } = webhookReq({ body, signature: null });
    expect((await res).status).toBe(401);
  });

  it("bad signature → 401", async () => {
    const body = makePushPayload("test/repo");
    const { res } = webhookReq({ body, signature: "sha256=badhash" });
    expect((await res).status).toBe(401);
  });
});
