/**
 * user-stats.test.ts — Stage 2 user-tier Pro stats endpoints.
 *
 * Covers:
 *   GET /stats/cost-histogram  — auth gate, tier gate, bucket logic
 *   GET /stats/genome-growth   — auth gate, tier gate, empty result
 *   GET /stats/cross-machine   — auth gate, tier gate, data shape
 *   GET /team/:orgId/aggregates — team-tier gate, org scoping
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, createUser, setUserTier } from "../src/db.js";

// ---------------------------------------------------------------------------
// Test DB setup
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
      org_id TEXT,
      org_role TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      comp_expires_at TEXT
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
    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      summarize_calls INTEGER NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );
    CREATE TABLE IF NOT EXISTS genome_push_log (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      genome_id TEXT NOT NULL,
      client_id TEXT NOT NULL DEFAULT 'test-client',
      path TEXT NOT NULL DEFAULT 'knowledge/test.md',
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      size_bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS genomes (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      owner_user_id TEXT
    );
    CREATE TABLE IF NOT EXISTS genome_sections (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      genome_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      vclock_json TEXT NOT NULL DEFAULT '{}',
      conflict_flag INTEGER NOT NULL DEFAULT 0,
      content_encrypted INTEGER NOT NULL DEFAULT 0,
      server_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE IF NOT EXISTS telemetry_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id_hash TEXT NOT NULL DEFAULT '',
      ts              INTEGER NOT NULL DEFAULT 0,
      kind            TEXT NOT NULL,
      payload         TEXT NOT NULL DEFAULT '0',
      stored_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_kind ON telemetry_events(session_id_hash, kind);
    CREATE INDEX IF NOT EXISTS idx_telemetry_events_kind_ts ON telemetry_events(kind, ts);
    CREATE INDEX IF NOT EXISTS idx_telemetry_events_stored_at ON telemetry_events(stored_at);
    CREATE INDEX IF NOT EXISTS idx_stats_uploads_user_id ON stats_uploads(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);
  `);
  return db;
}

const FREE_TOKEN = "free-user-token-stage2-00000000";
const PRO_TOKEN  = "pro-user-token-stage2-000000000";
const TEAM_TOKEN = "team-user-token-stage2-00000000";

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertDailyUsage(db: Database, userId: string, date: string, cost: number) {
  db.run(
    `INSERT INTO daily_usage (user_id, date, summarize_calls, total_cost) VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET total_cost = total_cost + excluded.total_cost`,
    [userId, date, cost],
  );
}

function insertStatsUpload(db: Database, userId: string, machineId: string, tokens: number, byTool: Record<string, number> = {}) {
  db.run(
    `INSERT INTO stats_uploads (id, user_id, lifetime_calls, lifetime_tokens_saved, by_tool_json, by_day_json, machine_id)
     VALUES (lower(hex(randomblob(16))), ?, 10, ?, ?, '{}', ?)`,
    [userId, tokens, JSON.stringify(byTool), machineId],
  );
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let freeUser: ReturnType<typeof createUser>;
let proUser:  ReturnType<typeof createUser>;
let teamUser: ReturnType<typeof createUser>;
let db: Database;

beforeEach(() => {
  db = makeTestDb();
  _setDb(db);

  freeUser = createUser("free@example.com",  FREE_TOKEN);
  proUser  = createUser("pro@example.com",   PRO_TOKEN);
  teamUser = createUser("team@example.com",  TEAM_TOKEN);

  setUserTier(proUser.id,  "pro");
  setUserTier(teamUser.id, "team");

  // Assign teamUser to an org
  db.run(`UPDATE users SET org_id = 'org-abc' WHERE id = ?`, [teamUser.id]);
});

afterEach(() => {
  _resetDb();
});

// ---------------------------------------------------------------------------
// GET /stats/cost-histogram
// ---------------------------------------------------------------------------

describe("GET /stats/cost-histogram", () => {
  it("returns 401 with no auth", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/cost-histogram"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for free-tier user", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/cost-histogram", {
      headers: authHeader(FREE_TOKEN),
    }));
    expect(res.status).toBe(403);
  });

  it("returns 200 with correct bucket keys for pro user with no data", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/cost-histogram?window=720", {
      headers: authHeader(PRO_TOKEN),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { buckets: { bucket: string; count: number }[] };
    const keys = body.buckets.map((b) => b.bucket);
    expect(keys).toContain("$0-1");
    expect(keys).toContain("$1-5");
    expect(keys).toContain("$5-25");
    expect(keys).toContain("$25-100");
    expect(keys).toContain("$100+");
  });

  it("buckets daily_usage rows correctly", async () => {
    // Insert rows in different cost bands
    const today = new Date().toISOString().slice(0, 10);
    insertDailyUsage(db, proUser.id, today, 0.50);        // $0-1
    insertDailyUsage(db, proUser.id, "2026-01-01", 2.00); // $1-5
    insertDailyUsage(db, proUser.id, "2026-01-02", 10.00);// $5-25

    const res = await app.fetch(new Request("http://localhost/stats/cost-histogram?window=99999", {
      headers: authHeader(PRO_TOKEN),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { buckets: { bucket: string; count: number }[] };
    const map = Object.fromEntries(body.buckets.map((b) => [b.bucket, b.count]));
    expect(map["$0-1"]).toBe(1);
    expect(map["$1-5"]).toBe(1);
    expect(map["$5-25"]).toBe(1);
  });

  it("does not leak another user's data", async () => {
    const today = new Date().toISOString().slice(0, 10);
    insertDailyUsage(db, freeUser.id, today, 50); // free user's row — should NOT appear

    const res = await app.fetch(new Request("http://localhost/stats/cost-histogram?window=9999", {
      headers: authHeader(PRO_TOKEN),
    }));
    const body = await res.json() as { buckets: { bucket: string; count: number }[] };
    const total = body.buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(0); // proUser has no daily_usage rows
  });
});

// ---------------------------------------------------------------------------
// GET /stats/genome-growth
// ---------------------------------------------------------------------------

describe("GET /stats/genome-growth", () => {
  it("returns 401 with no auth", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/genome-growth"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for free-tier user", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/genome-growth", {
      headers: authHeader(FREE_TOKEN),
    }));
    expect(res.status).toBe(403);
  });

  it("returns 200 with empty rows when no genome events", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/genome-growth", {
      headers: authHeader(PRO_TOKEN),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: unknown[] };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /stats/cross-machine
// ---------------------------------------------------------------------------

describe("GET /stats/cross-machine", () => {
  it("returns 401 with no auth", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/cross-machine"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for free-tier user", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/cross-machine", {
      headers: authHeader(FREE_TOKEN),
    }));
    expect(res.status).toBe(403);
  });

  it("returns 200 with correct shape for pro user", async () => {
    insertStatsUpload(db, proUser.id, "mac-1", 50000);
    insertStatsUpload(db, proUser.id, "mac-2", 30000);

    const res = await app.fetch(new Request("http://localhost/stats/cross-machine?window=9999", {
      headers: authHeader(PRO_TOKEN),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: { day: string; machine: string; tokens_saved: number }[] };
    expect(Array.isArray(body.rows)).toBe(true);
    // Should have at least one row per machine
    const machines = new Set(body.rows.map((r) => r.machine));
    expect(machines.has("mac-1")).toBe(true);
    expect(machines.has("mac-2")).toBe(true);
  });

  it("does not return another user's machines", async () => {
    insertStatsUpload(db, freeUser.id, "evil-machine", 999999);

    const res = await app.fetch(new Request("http://localhost/stats/cross-machine?window=9999", {
      headers: authHeader(PRO_TOKEN),
    }));
    const body = await res.json() as { rows: { machine: string }[] };
    expect(body.rows.every((r) => r.machine !== "evil-machine")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /team/:orgId/aggregates
// ---------------------------------------------------------------------------

describe("GET /team/:orgId/aggregates", () => {
  it("returns 401 with no auth", async () => {
    const res = await app.fetch(new Request("http://localhost/team/org-abc/aggregates"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for free-tier user", async () => {
    const res = await app.fetch(new Request("http://localhost/team/org-abc/aggregates", {
      headers: authHeader(FREE_TOKEN),
    }));
    expect(res.status).toBe(403);
  });

  it("returns 403 for pro (non-team) user", async () => {
    const res = await app.fetch(new Request("http://localhost/team/org-abc/aggregates", {
      headers: authHeader(PRO_TOKEN),
    }));
    expect(res.status).toBe(403);
  });

  it("returns 403 when team user requests a different org", async () => {
    const res = await app.fetch(new Request("http://localhost/team/org-other/aggregates", {
      headers: authHeader(TEAM_TOKEN),
    }));
    expect(res.status).toBe(403);
  });

  it("returns 200 with aggregate shape for team user requesting own org", async () => {
    insertStatsUpload(db, teamUser.id, "mac-1", 100000, { "ashlr__read": 50, "ashlr__grep": 30 });

    const res = await app.fetch(new Request("http://localhost/team/org-abc/aggregates", {
      headers: authHeader(TEAM_TOKEN),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      total_tokens_saved: number;
      member_count: number;
      top_tools: { name: string; calls: number }[];
    };
    expect(typeof body.total_tokens_saved).toBe("number");
    expect(typeof body.member_count).toBe("number");
    expect(body.member_count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.top_tools)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /stats/genome-insights
// ---------------------------------------------------------------------------

describe("GET /stats/genome-insights", () => {
  it("returns 401 with no auth", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/genome-insights"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for free-tier user", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/genome-insights", {
      headers: authHeader(FREE_TOKEN),
    }));
    expect(res.status).toBe(403);
  });

  it("returns empty insights shape when pro user has no genome", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/genome-insights?window=7", {
      headers: authHeader(PRO_TOKEN),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      top_sections: unknown[];
      sections_added_this_week: number;
      sections_modified_this_week: number;
      total_retrievals_week: number;
      cache_hit_rate: number;
    };
    expect(Array.isArray(body.top_sections)).toBe(true);
    expect(body.top_sections.length).toBe(0);
    expect(body.sections_added_this_week).toBe(0);
    expect(body.sections_modified_this_week).toBe(0);
    expect(body.total_retrievals_week).toBe(0);
    expect(typeof body.cache_hit_rate).toBe("number");
  });

  it("returns correct shape and counts with genome push activity", async () => {
    // Create a personal genome for proUser
    const genomeId = "genome-pro-test-001";
    db.run(`INSERT INTO genomes (id, owner_user_id) VALUES (?, ?)`, [genomeId, proUser.id]);

    // Push two sections this week
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO genome_push_log (id, genome_id, client_id, path, at) VALUES (?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), genomeId, "cli-1", "knowledge/architecture.md", now],
    );
    db.run(
      `INSERT INTO genome_push_log (id, genome_id, client_id, path, at) VALUES (?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), genomeId, "cli-1", "knowledge/architecture.md", now],
    );
    db.run(
      `INSERT INTO genome_push_log (id, genome_id, client_id, path, at) VALUES (?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), genomeId, "cli-1", "knowledge/patterns.md", now],
    );

    // Insert section content for byte lookup
    db.run(
      `INSERT INTO genome_sections (genome_id, path, content) VALUES (?, ?, ?)`,
      [genomeId, "knowledge/architecture.md", "x".repeat(2048)],
    );

    const res = await app.fetch(new Request("http://localhost/stats/genome-insights?window=7", {
      headers: authHeader(PRO_TOKEN),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      top_sections: { name: string; retrievals: number; bytes: number }[];
      sections_added_this_week: number;
      sections_modified_this_week: number;
      total_retrievals_week: number;
      cache_hit_rate: number;
    };

    expect(Array.isArray(body.top_sections)).toBe(true);
    expect(body.top_sections.length).toBeGreaterThan(0);

    // Top section should be architecture.md (2 pushes)
    expect(body.top_sections[0]!.name).toBe("knowledge/architecture.md");
    expect(body.top_sections[0]!.retrievals).toBe(2);
    expect(body.top_sections[0]!.bytes).toBe(2048);

    expect(body.total_retrievals_week).toBe(3);
    expect(body.sections_added_this_week).toBe(2); // both paths first-seen this week
    expect(typeof body.cache_hit_rate).toBe("number");
    expect(body.cache_hit_rate).toBeGreaterThanOrEqual(0);
    expect(body.cache_hit_rate).toBeLessThanOrEqual(1);
  });

  it("returns 400 for invalid window parameter", async () => {
    const res = await app.fetch(new Request("http://localhost/stats/genome-insights?window=abc", {
      headers: authHeader(PRO_TOKEN),
    }));
    expect(res.status).toBe(400);
  });
});
