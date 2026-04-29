/**
 * llm-error-codes.test.ts — Typed error code contracts for POST /llm/summarize.
 *
 * Verifies:
 *   - Rate-limit 429 → code: "rate_limit" + Retry-After header
 *   - Daily-cap 429  → code: "daily_cap"  + resetsAt ISO string
 *   - Cost-cap 402   → code: "cost_cap"   + resetsAt ISO string
 *   - Existing 200 response shape unchanged
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, createUser, setUserTier } from "../src/db.js";
import { _clearBuckets, _clearSlidingWindows } from "../src/lib/ratelimit.js";
import { _clearLlmCache } from "../src/routes/llm.js";

// ---------------------------------------------------------------------------
// Anthropic SDK mock (same pattern as llm.test.ts)
// ---------------------------------------------------------------------------

mock.module("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = {
      create: async (_params: unknown) => ({
        content: [{ type: "text", text: "mocked summary" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    };
  }
  return { default: Anthropic };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = "testtoken-errcodes-5678";

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
      by_day_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_stats_uploads_user_id ON stats_uploads(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);

    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      summarize_calls INTEGER NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0.0,
      PRIMARY KEY (user_id, date)
    );

    CREATE TABLE IF NOT EXISTS llm_calls (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      tool_name TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0.0,
      cached INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS monthly_usage (
      user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      month    TEXT NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0.0,
      PRIMARY KEY (user_id, month)
    );

    CREATE TABLE IF NOT EXISTS daily_cap_notifications (
      user_id TEXT NOT NULL,
      date    TEXT NOT NULL,
      PRIMARY KEY (user_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_usage(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_user_at ON llm_calls(user_id, at);
    CREATE INDEX IF NOT EXISTS idx_monthly_usage_user_month ON monthly_usage(user_id, month);
  `);
  return db;
}

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    text: "some code content to summarize",
    systemPrompt: "You are a summarizer.",
    toolName: "ashlr__read",
    ...overrides,
  });
}

async function summarize(body: string, token = VALID_TOKEN): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/llm/summarize", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    }),
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  const db = makeTestDb();
  _setDb(db);
  const u = createUser("errcodes-test@example.com", VALID_TOKEN);
  setUserTier(u.id, "pro");
  _clearBuckets();
  _clearSlidingWindows();
  _clearLlmCache();
  process.env.ANTHROPIC_API_KEY = "test-key-never-used";
  delete process.env.LLM_COST_CAP_USD;
});

afterEach(() => {
  _resetDb();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LLM_COST_CAP_USD;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /llm/summarize — typed error codes", () => {
  // -------------------------------------------------------------------------
  // rate_limit (sliding-window 429)
  // -------------------------------------------------------------------------

  it("rate-limit 429 returns code='rate_limit' and Retry-After header", async () => {
    // Exhaust the 30 req/min bucket
    for (let i = 0; i < 30; i++) {
      await summarize(validBody({ text: `req ${i}` }));
    }
    const res = await summarize(validBody({ text: "over limit" }));

    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; code: string; retryAfter: number };
    expect(body.code).toBe("rate_limit");
    expect(body.error).toContain("Rate limit");
    expect(typeof body.retryAfter).toBe("number");
    expect(body.retryAfter).toBeGreaterThan(0);

    // Retry-After header must be present
    const retryAfterHeader = res.headers.get("retry-after");
    expect(retryAfterHeader).not.toBeNull();
    expect(parseInt(retryAfterHeader!, 10)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // daily_cap (per-day call-count 429)
  // -------------------------------------------------------------------------

  it("daily-cap 429 returns code='daily_cap' and resetsAt", async () => {
    const { getDb } = await import("../src/db.js");
    const db   = getDb();
    const user = db.query<{ id: string }, [string]>(
      `SELECT id FROM users WHERE api_token = ?`,
    ).get(VALID_TOKEN)!;
    const today = new Date().toISOString().slice(0, 10);
    db.run(
      `INSERT INTO daily_usage (user_id, date, summarize_calls, total_cost)
       VALUES (?, ?, 1000, 0.0)
       ON CONFLICT(user_id, date) DO UPDATE SET summarize_calls = 1000`,
      [user.id, today],
    );

    const res = await summarize(validBody());

    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; code: string; resetsAt: string };
    expect(body.code).toBe("daily_cap");
    expect(body.error.toLowerCase()).toContain("daily cap");
    // resetsAt must be a valid ISO date in the future
    expect(typeof body.resetsAt).toBe("string");
    expect(new Date(body.resetsAt).getTime()).toBeGreaterThan(Date.now());
  });

  // -------------------------------------------------------------------------
  // cost_cap (monthly USD 402)
  // -------------------------------------------------------------------------

  it("cost-cap 402 returns code='cost_cap' with resetsAt when monthly spend exceeded", async () => {
    const { getDb } = await import("../src/db.js");
    const db   = getDb();
    const user = db.query<{ id: string }, [string]>(
      `SELECT id FROM users WHERE api_token = ?`,
    ).get(VALID_TOKEN)!;
    const month = new Date().toISOString().slice(0, 7);
    // Insert a spend equal to the default cap ($5)
    db.run(
      `INSERT INTO monthly_usage (user_id, month, cost_usd) VALUES (?, ?, 5.00)`,
      [user.id, month],
    );

    const res = await summarize(validBody());

    expect(res.status).toBe(402);
    const body = await res.json() as { error: string; code: string; resetsAt: string };
    expect(body.code).toBe("cost_cap");
    expect(body.error.toLowerCase()).toContain("monthly cost cap");
    // resetsAt must be a valid ISO date in the future
    expect(typeof body.resetsAt).toBe("string");
    expect(new Date(body.resetsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("cost-cap threshold is configurable via LLM_COST_CAP_USD env", async () => {
    process.env.LLM_COST_CAP_USD = "0.01"; // very low cap

    const { getDb } = await import("../src/db.js");
    const db   = getDb();
    const user = db.query<{ id: string }, [string]>(
      `SELECT id FROM users WHERE api_token = ?`,
    ).get(VALID_TOKEN)!;
    const month = new Date().toISOString().slice(0, 7);
    db.run(
      `INSERT INTO monthly_usage (user_id, month, cost_usd) VALUES (?, ?, 0.01)`,
      [user.id, month],
    );

    const res = await summarize(validBody());
    expect(res.status).toBe(402);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("cost_cap");
  });

  // -------------------------------------------------------------------------
  // 200 response shape unchanged
  // -------------------------------------------------------------------------

  it("200 response does not include a 'code' field", async () => {
    const res = await summarize(validBody());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect("code" in body).toBe(false);
    expect(body.summary).toBe("mocked summary");
  });
});
