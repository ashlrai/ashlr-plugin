/**
 * Integration tests for POST /events/nudge.
 *
 * Same test-harness pattern as server/tests/stats.test.ts — an in-memory
 * SQLite database, seed user, app.fetch() round-trips.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import {
  _setDb,
  _resetDb,
  createUser,
  aggregateNudgeEvents,
} from "../src/db.js";
import { _clearBuckets, _backdateBucket } from "../src/lib/ratelimit.js";

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

const VALID_TOKEN = "valid-nudge-token-000000000000000000";

const VALID_EVENTS = [
  {
    ts:         "2025-04-21T12:00:00Z",
    event:      "nudge_shown",
    sessionId:  "session-hash-1",
    tokenCount: 50_000,
    variant:    "v1",
    nudgeId:    "nudge-uuid-1",
  },
  {
    ts:         "2025-04-21T12:05:00Z",
    event:      "nudge_clicked",
    sessionId:  "session-hash-1",
    tokenCount: 50_000,
    variant:    "v1",
    nudgeId:    "nudge-uuid-1",
  },
];

describe("POST /events/nudge", () => {
  let userId: string;

  beforeEach(() => {
    _setDb(makeTestDb());
    _clearBuckets();
    const u = createUser("nudge-test@example.com", VALID_TOKEN);
    userId = u.id;
  });

  afterEach(() => {
    _resetDb();
  });

  async function post(body: unknown, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return app.fetch(
      new Request("http://localhost/events/nudge", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  }

  it("stores a valid batch of events and returns {stored: N}", async () => {
    const res = await post({ events: VALID_EVENTS }, VALID_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json() as { stored: number };
    expect(body.stored).toBe(2);

    const agg = aggregateNudgeEvents(userId);
    expect(agg.shown).toBe(1);
    expect(agg.clicked).toBe(1);
    expect(agg.dismissed).toBe(0);
  });

  it("accepts an empty events array", async () => {
    const res = await post({ events: [] }, VALID_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json() as { stored: number };
    expect(body.stored).toBe(0);
  });

  it("rejects missing Authorization → 401", async () => {
    const res = await post({ events: VALID_EVENTS }, null);
    expect(res.status).toBe(401);
  });

  it("rejects an invalid bearer token → 401", async () => {
    const res = await post({ events: VALID_EVENTS }, "not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON → 400", async () => {
    const res = await app.fetch(new Request("http://localhost/events/nudge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_TOKEN}` },
      body: "{not-json",
    }));
    expect(res.status).toBe(400);
  });

  it("rejects an unknown event kind → 400", async () => {
    const bad = [{ ...VALID_EVENTS[0], event: "nudge_hijacked" }];
    const res = await post({ events: bad }, VALID_TOKEN);
    expect(res.status).toBe(400);
  });

  it("rejects a tokenCount that is negative → 400", async () => {
    const bad = [{ ...VALID_EVENTS[0], tokenCount: -1 }];
    const res = await post({ events: bad }, VALID_TOKEN);
    expect(res.status).toBe(400);
  });

  it("rejects missing fields → 400", async () => {
    const bad = [{ ts: "2025-04-21T12:00:00Z", event: "nudge_shown" }];
    const res = await post({ events: bad }, VALID_TOKEN);
    expect(res.status).toBe(400);
  });

  it("stores events scoped to the authenticated user", async () => {
    // Create a second user; its aggregate must stay at 0.
    const other = createUser("other@example.com", "other-token-0000000000000000000000");
    const res = await post({ events: VALID_EVENTS }, VALID_TOKEN);
    expect(res.status).toBe(200);
    const own = aggregateNudgeEvents(userId);
    const theirs = aggregateNudgeEvents(other.id);
    expect(own.shown).toBe(1);
    expect(theirs.shown).toBe(0);
  });

  it("dedupe across batches: repeated POST adds more rows (no insert-ignore)", async () => {
    await post({ events: VALID_EVENTS }, VALID_TOKEN);
    _backdateBucket(`nudge:${userId}`, 11_000);
    const second = await post({ events: VALID_EVENTS }, VALID_TOKEN);
    expect(second.status).toBe(200);
    const agg = aggregateNudgeEvents(userId);
    // Client is the source of truth for dedupe — server treats each POST as append-only.
    expect(agg.shown).toBe(2);
    expect(agg.clicked).toBe(2);
  });

  it("rate-limits a second POST within 10s → 429", async () => {
    const first = await post({ events: VALID_EVENTS }, VALID_TOKEN);
    expect(first.status).toBe(200);
    const second = await post({ events: VALID_EVENTS }, VALID_TOKEN);
    expect(second.status).toBe(429);
    // Only the first batch's rows should have landed.
    expect(aggregateNudgeEvents(userId).shown).toBe(1);
  });

  it("allows a second POST after the rate-limit window elapses", async () => {
    const first = await post({ events: VALID_EVENTS }, VALID_TOKEN);
    expect(first.status).toBe(200);
    _backdateBucket(`nudge:${userId}`, 11_000);
    const second = await post({ events: VALID_EVENTS }, VALID_TOKEN);
    expect(second.status).toBe(200);
    expect(aggregateNudgeEvents(userId).shown).toBe(2);
  });
});
