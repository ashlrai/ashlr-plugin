/**
 * llm.test.ts — Tests for POST /llm/summarize (Phase 2).
 *
 * The Anthropic SDK is mocked globally so no real API calls are made.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb, createUser, setUserTier } from "../src/db.js";
import { _clearBuckets } from "../src/lib/ratelimit.js";
import { _clearSlidingWindows } from "../src/lib/ratelimit.js";
import { _clearLlmCache } from "../src/routes/llm.js";

// ---------------------------------------------------------------------------
// Anthropic SDK mock
// ---------------------------------------------------------------------------

// We need to intercept `new Anthropic(...)` and its `.messages.create()` call.
// Bun's mock.module lets us replace the whole module import.

let mockCreateResponse: () => object = () => ({
  content: [{ type: "text", text: "mocked summary" }],
  usage: { input_tokens: 100, output_tokens: 50 },
});

mock.module("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = {
      create: async (_params: unknown) => mockCreateResponse(),
    };
  }
  return { default: Anthropic };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = "testtoken-llm-1234";

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
    CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_usage(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_user_at ON llm_calls(user_id, at);
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
  const u = createUser("llm-test@example.com", VALID_TOKEN);
  setUserTier(u.id, "pro"); // llm/summarize requires paid tier
  _clearBuckets();
  _clearSlidingWindows();
  _clearLlmCache();
  // Reset mock to default happy-path response
  mockCreateResponse = () => ({
    content: [{ type: "text", text: "mocked summary" }],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  process.env.ANTHROPIC_API_KEY = "test-key-never-used";
});

afterEach(() => {
  _resetDb();
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /llm/summarize", () => {
  it("happy path: valid body returns 200 with summary and accounting fields", async () => {
    const res  = await summarize(validBody());
    expect(res.status).toBe(200);

    const body = await res.json() as {
      summary: string;
      modelUsed: string;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    };
    expect(body.summary).toBe("mocked summary");
    expect(body.modelUsed).toContain("haiku");
    expect(body.inputTokens).toBe(100);
    expect(body.outputTokens).toBe(50);
    expect(typeof body.cost).toBe("number");
    expect(body.cost).toBeGreaterThan(0);
  });

  it("over-size text returns 413", async () => {
    const bigText = "x".repeat(64 * 1024 + 1);
    const res = await summarize(validBody({ text: bigText }));
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("text exceeds");
  });

  it("over-size systemPrompt returns 413", async () => {
    const bigPrompt = "x".repeat(2 * 1024 + 1);
    const res = await summarize(validBody({ systemPrompt: bigPrompt }));
    expect(res.status).toBe(413);
  });

  it("bad auth returns 401", async () => {
    const res = await summarize(validBody(), "not-a-valid-token");
    expect(res.status).toBe(401);
  });

  it("missing Authorization header returns 401", async () => {
    const res = await app.fetch(
      new Request("http://localhost/llm/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validBody(),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("schema validation: missing text field returns 400", async () => {
    const res = await summarize(JSON.stringify({
      systemPrompt: "you are a summarizer",
      toolName: "ashlr__read",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Invalid request body");
  });

  it("schema validation: missing toolName returns 400", async () => {
    const res = await summarize(JSON.stringify({
      text: "some text",
      systemPrompt: "you are a summarizer",
    }));
    expect(res.status).toBe(400);
  });

  it("rate limit: 31st rapid request in the same minute returns 429", async () => {
    // Send 30 requests (should all pass)
    for (let i = 0; i < 30; i++) {
      const res = await summarize(validBody({ text: `request ${i}` }));
      expect(res.status).toBe(200);
    }
    // 31st should be rate-limited
    const res = await summarize(validBody({ text: "request 31" }));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Rate limit");
  });

  it("cache hit: second identical request returns cost=0 and modelUsed='cache'", async () => {
    const req = validBody();

    const res1 = await summarize(req);
    expect(res1.status).toBe(200);
    const b1 = await res1.json() as { cost: number; modelUsed: string };
    expect(b1.cost).toBeGreaterThan(0);
    expect(b1.modelUsed).not.toBe("cache");

    const res2 = await summarize(req);
    expect(res2.status).toBe(200);
    const b2 = await res2.json() as { cost: number; modelUsed: string };
    expect(b2.cost).toBe(0);
    expect(b2.modelUsed).toBe("cache");
  });

  it("daily cap hit returns 429 with 'daily cap reached'", async () => {
    // Exhaust the call cap by directly writing to daily_usage
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
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toContain("daily cap");
  });

  it("upstream LLM failure returns 502 without leaking upstream error", async () => {
    mockCreateResponse = () => { throw new Error("upstream-secret-error-detail"); };

    const res  = await summarize(validBody());
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    // Must be a generic message — no upstream detail
    expect(body.error).not.toContain("upstream-secret-error-detail");
    expect(body.error).not.toContain("Error:");
  });

  it("maxTokens is capped at 1500 — exceeding value is rejected", async () => {
    const res = await summarize(validBody({ maxTokens: 9999 }));
    expect(res.status).toBe(400);
  });

  it("ANTHROPIC_API_KEY missing returns 502", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await summarize(validBody());
    expect(res.status).toBe(502);
  });
});
