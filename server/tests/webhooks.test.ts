/**
 * webhooks.test.ts — GitHub webhook endpoint tests (v1.14).
 *
 * Covers:
 *   - Missing signature → 401
 *   - Bad signature → 401
 *   - Valid signature + ping → 200 {pong: true}
 *   - Valid signature + push on known genome → 202 + DB row
 *   - Valid signature + push on unknown repo → 200 "no subscribed genome"
 *   - Replay of same delivery id → 200 "already processed"
 *   - Missing GITHUB_WEBHOOK_SECRET → 500
 *   - Unknown event type → 202 "ignored"
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import {
  _setDb,
  _resetDb,
  createUser,
  setUserTier,
  hasProcessedDelivery,
  getPersonalGenomeByRepoUrl,
} from "../src/db.js";
import app from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-webhook-secret-abc123";

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
  event?: string;
  signature?: string | null;
  deliveryId?: string;
}) {
  const {
    body,
    event = "push",
    signature = sign(body),
    deliveryId = crypto.randomUUID(),
  } = opts;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-github-event": event,
    "x-github-delivery": deliveryId,
  };
  if (signature !== null) {
    headers["x-hub-signature-256"] = signature;
  }

  return app.request("/webhooks/github", {
    method: "POST",
    headers,
    body,
  });
}

function makePushPayload(fullName: string, headSha = "abc123def456"): string {
  return JSON.stringify({
    after: headSha,
    ref: "refs/heads/main",
    repository: { full_name: fullName, private: false },
    commits: [
      {
        id: headSha,
        added: ["src/foo.ts"],
        modified: [],
        removed: [],
      },
    ],
    sender: { login: "testuser" },
  });
}

function insertPersonalGenome(userId: string, repoUrl: string): string {
  const db = require("../src/db.js").getDb() as Database;
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO genomes (id, org_id, repo_url, owner_user_id, repo_visibility, build_status)
     VALUES (?, ?, ?, ?, 'public', 'ready')`,
    [id, userId, repoUrl, userId],
  );
  return id;
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
  if (originalSecret === undefined) {
    delete process.env["GITHUB_WEBHOOK_SECRET"];
  } else {
    process.env["GITHUB_WEBHOOK_SECRET"] = originalSecret;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /webhooks/github", () => {
  it("returns 401 when signature header is missing", async () => {
    const body = makePushPayload("owner/repo");
    const res = await webhookRequest({ body, signature: null });
    expect(res.status).toBe(401);
  });

  it("returns 401 when signature is incorrect", async () => {
    const body = makePushPayload("owner/repo");
    const res = await webhookRequest({ body, signature: "sha256=deadbeef" });
    expect(res.status).toBe(401);
  });

  it("returns 200 {pong: true} for ping event", async () => {
    const body = JSON.stringify({ zen: "Keep it simple." });
    const res = await webhookRequest({ body, event: "ping" });
    expect(res.status).toBe(200);
    const json = await res.json() as { pong: boolean };
    expect(json.pong).toBe(true);
  });

  it("returns 202 'ignored' for unknown event types", async () => {
    const body = JSON.stringify({ action: "created" });
    const res = await webhookRequest({ body, event: "issues" });
    expect(res.status).toBe(202);
    const json = await res.json() as { message: string };
    expect(json.message).toBe("ignored");
  });

  it("returns 200 'no subscribed genome' for push on unknown repo", async () => {
    const body = makePushPayload("nobody/nonexistent-repo");
    const res = await webhookRequest({ body });
    expect(res.status).toBe(200);
    const json = await res.json() as { message: string };
    expect(json.message).toBe("no subscribed genome");
  });

  it("returns 202 and records webhook_events row for push on known genome", async () => {
    // Create user + genome
    const token = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
    const user = createUser("webhook@test.com", token);
    setUserTier(user.id, "pro");
    const repoUrl = "https://github.com/owner/myrepo";
    insertPersonalGenome(user.id, repoUrl);

    // Mock rebuildGenomeDelta to avoid actual git clone
    const genomeBuild = await import("../src/services/genome-build.js");
    const rebuildSpy = spyOn(genomeBuild, "rebuildGenomeDelta").mockResolvedValue({
      sectionsUpdated: 3,
      durationMs: 100,
      changeSummary: "1 file(s) changed: src/foo.ts",
    });

    const deliveryId = crypto.randomUUID();
    const body = makePushPayload("owner/myrepo");
    const res = await webhookRequest({ body, deliveryId });

    expect(res.status).toBe(202);
    const json = await res.json() as { message: string };
    expect(json.message).toBe("queued");

    // Verify DB row was recorded
    expect(hasProcessedDelivery(deliveryId)).toBe(true);

    rebuildSpy.mockRestore();
  });

  it("returns 200 'already processed' for replay of same delivery id", async () => {
    const token = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
    const user = createUser("replay@test.com", token);
    setUserTier(user.id, "pro");
    const repoUrl = "https://github.com/owner/replayrepo";
    insertPersonalGenome(user.id, repoUrl);

    const genomeBuild = await import("../src/services/genome-build.js");
    const rebuildSpy = spyOn(genomeBuild, "rebuildGenomeDelta").mockResolvedValue({
      sectionsUpdated: 0,
      durationMs: 50,
      changeSummary: "none",
    });

    const deliveryId = crypto.randomUUID();
    const body = makePushPayload("owner/replayrepo");

    // First delivery
    const res1 = await webhookRequest({ body, deliveryId });
    expect(res1.status).toBe(202);

    // Replay same delivery id
    const res2 = await webhookRequest({ body, deliveryId });
    expect(res2.status).toBe(200);
    const json = await res2.json() as { message: string };
    expect(json.message).toBe("already processed");

    rebuildSpy.mockRestore();
  });

  it("returns 500 when GITHUB_WEBHOOK_SECRET is not set", async () => {
    delete process.env["GITHUB_WEBHOOK_SECRET"];
    const body = makePushPayload("owner/repo");
    const res = await webhookRequest({ body });
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("webhook not configured");
  });
});
