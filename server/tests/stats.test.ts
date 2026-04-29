import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, createUser, setUserTier } from "../src/db.js";
import { _clearBuckets, _backdateBucket } from "../src/lib/ratelimit.js";

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
      by_day_json TEXT NOT NULL DEFAULT '{}',
      machine_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stats_uploads_user_id ON stats_uploads(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id    ON api_tokens(user_id);
  `);
  return db;
}

const VALID_TOKEN = "valid-token-stats-0000000000000000";
const VALID_PAYLOAD = {
  apiToken: VALID_TOKEN,
  stats: {
    lifetime: {
      calls: 100,
      tokensSaved: 50000,
      byTool: { "ashlr__read": 60, "ashlr__grep": 40 },
      byDay:  { "2025-01-01": 25000, "2025-01-02": 25000 },
    },
  },
};

describe("POST /stats/sync", () => {
  let user: ReturnType<typeof createUser>;

  beforeEach(() => {
    _setDb(makeTestDb());
    _clearBuckets();
    user = createUser("stats-test@example.com", VALID_TOKEN);
  });

  afterEach(() => {
    _resetDb();
    _clearBuckets();
  });

  it("accepts valid payload and returns 200", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_PAYLOAD),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("rejects payload with a path-like field", async () => {
    const evilPayload = {
      apiToken: VALID_TOKEN,
      stats: {
        lifetime: {
          calls: 1,
          tokensSaved: 100,
          cwd: "/Users/mason/secret-project",
        },
      },
    };
    const res = await app.fetch(new Request("http://localhost/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evilPayload),
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("disallowed");
  });

  it("rejects payload with string value that looks like a path", async () => {
    const evilPayload = {
      apiToken: VALID_TOKEN,
      stats: {
        lifetime: {
          calls: 1,
          tokensSaved: 100,
          byTool: { "ashlr__read": "/Users/mason/file.ts" },
        },
      },
    };
    const res = await app.fetch(new Request("http://localhost/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evilPayload),
    }));
    // Either 422 (privacy check) or 400 (schema: expected number got string)
    expect([400, 422]).toContain(res.status);
  });

  it("rejects payload with invalid schema (missing required fields)", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiToken: VALID_TOKEN, stats: {} }),
    }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid API token with 401", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID_PAYLOAD, apiToken: "completely-wrong-token-000000000" }),
    }));
    expect(res.status).toBe(401);
  });

  it("rate limits the second request within 10s", async () => {
    // First request — should succeed
    const res1 = await app.fetch(new Request("http://localhost/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_PAYLOAD),
    }));
    expect(res1.status).toBe(200);

    // Second request immediately — should be rate limited
    const res2 = await app.fetch(new Request("http://localhost/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_PAYLOAD),
    }));
    expect(res2.status).toBe(429);
  });
});

describe("GET /stats/aggregate", () => {
  let user: ReturnType<typeof createUser>;

  beforeEach(() => {
    _setDb(makeTestDb());
    _clearBuckets();
    user = createUser("agg-test@example.com", VALID_TOKEN);
    setUserTier(user.id, "pro");
  });

  afterEach(() => {
    _resetDb();
    _clearBuckets();
  });

  it("returns 401 with missing Authorization header", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/aggregate"));
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/aggregate", {
      headers: { "Authorization": "Bearer totally-wrong-token-00000000000000" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns caller's aggregate sum after syncing two uploads", async () => {
    // Upload from "machine A"
    await app.fetch(new Request("http://localhost/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiToken: VALID_TOKEN,
        machineId: "machine-A",
        stats: {
          lifetime: { calls: 100, tokensSaved: 50000, byTool: { "ashlr__read": 60 }, byDay: { "2025-01-01": 50000 } },
        },
      }),
    }));

    // Backdate the rate limit bucket so the second sync request is allowed
    _backdateBucket(VALID_TOKEN, 15_000);

    // Upload from "machine B" (higher lifetime counters)
    await app.fetch(new Request("http://localhost/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiToken: VALID_TOKEN,
        machineId: "machine-B",
        stats: {
          lifetime: { calls: 200, tokensSaved: 80000, byTool: { "ashlr__grep": 40 }, byDay: { "2025-01-02": 30000 } },
        },
      }),
    }));

    const res = await app.fetch(new Request("http://localhost/stats/aggregate", {
      headers: { "Authorization": `Bearer ${VALID_TOKEN}` },
    }));
    expect(res.status).toBe(200);

    const body = await res.json() as {
      lifetime_calls: number;
      lifetime_tokens_saved: number;
      by_tool: Record<string, number>;
      by_day: Record<string, number>;
      machine_count: number;
    };

    // Aggregate takes max of lifetime fields
    expect(body.lifetime_calls).toBe(200);
    expect(body.lifetime_tokens_saved).toBe(80000);
    // by_tool sums across rows
    expect(body.by_tool["ashlr__read"]).toBe(60);
    expect(body.by_tool["ashlr__grep"]).toBe(40);
    // Two distinct machines
    expect(body.machine_count).toBe(2);
  });

  it("machine_count is 2 for two uploads from distinct machines", async () => {
    await app.fetch(new Request("http://localhost/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiToken: VALID_TOKEN,
        machineId: "A",
        stats: { lifetime: { calls: 10, tokensSaved: 1000 } },
      }),
    }));

    _backdateBucket(VALID_TOKEN, 15_000);

    await app.fetch(new Request("http://localhost/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiToken: VALID_TOKEN,
        machineId: "B",
        stats: { lifetime: { calls: 20, tokensSaved: 2000 } },
      }),
    }));

    const res = await app.fetch(new Request("http://localhost/stats/aggregate", {
      headers: { "Authorization": `Bearer ${VALID_TOKEN}` },
    }));
    const body = await res.json() as { machine_count: number };
    expect(body.machine_count).toBe(2);
  });

  it("machine_count is 1 for three uploads all from the same machine", async () => {
    for (let i = 0; i < 3; i++) {
      if (i > 0) _backdateBucket(VALID_TOKEN, 15_000);
      await app.fetch(new Request("http://localhost/stats/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiToken: VALID_TOKEN,
          machineId: "only-machine",
          stats: { lifetime: { calls: 10 + i, tokensSaved: 1000 + i } },
        }),
      }));
    }

    const res = await app.fetch(new Request("http://localhost/stats/aggregate", {
      headers: { "Authorization": `Bearer ${VALID_TOKEN}` },
    }));
    const body = await res.json() as { machine_count: number };
    expect(body.machine_count).toBe(1);
  });

  it("machine_count is 1 for legacy rows (null machine_id) counted as collective machine", async () => {
    // Insert a row directly with NULL machine_id to simulate a pre-migration legacy row
    const { getDb } = await import("../src/db.js");
    const db = getDb();
    db.run(
      `INSERT INTO stats_uploads (id, user_id, lifetime_calls, lifetime_tokens_saved, by_tool_json, by_day_json, machine_id)
       VALUES (?, ?, 50, 5000, '{}', '{}', NULL)`,
      [crypto.randomUUID(), user.id],
    );

    const res = await app.fetch(new Request("http://localhost/stats/aggregate", {
      headers: { "Authorization": `Bearer ${VALID_TOKEN}` },
    }));
    const body = await res.json() as { machine_count: number };
    // NULL machine_id rows collapse to the 'legacy' sentinel → 1 machine
    expect(body.machine_count).toBe(1);
  });
});
