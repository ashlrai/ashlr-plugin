/**
 * telemetry.test.ts — POST /v1/events.
 *
 * Opt-in anonymized telemetry ingest. Mirrors the v1.23 client contract in
 * `servers/_telemetry.ts` + `scripts/telemetry-flush.ts`. Server-side
 * defense-in-depth: re-runs `looksLikePath()`, hashes sessionId, validates
 * schema, rate-limits per session.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import app from "../src/index.js";
import { _clearSlidingWindows } from "../src/lib/ratelimit.js";
import { looksLikePath } from "../src/routes/telemetry.js";
import { getDb } from "../src/db.js";

const SID = "0123456789abcdef"; // 16-char hex per client convention

function evt(kind: string, extra: Record<string, unknown> = {}, ts = Math.floor(Date.now() / 1000)) {
  return { ts, kind, sessionId: SID, ...extra };
}

function postEvents(events: Array<Record<string, unknown>>, sessionId = SID) {
  return app.fetch(
    new Request("http://localhost/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, events }),
    }),
  );
}

describe("POST /v1/events — happy path", () => {
  beforeEach(() => {
    _clearSlidingWindows();
    // Fresh table state for assertions across tests.
    getDb().exec("DELETE FROM telemetry_events");
  });

  it("accepts a valid batch and returns accepted count", async () => {
    const res = await postEvents([
      evt("tool_call", { tool: "ashlr__read", rawBytes: 8200, compactBytes: 1100, fellBack: false, providerUsed: "anthropic", durationMs: 450 }),
      evt("pretooluse_block", { tool: "Read", blockedTo: "ashlr__read", sizeRange: "medium" }),
      evt("version", { pluginVersion: "1.23.0", bunVersion: "1.3.10", platform: "darwin", arch: "arm64" }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(3);
  });

  it("persists events to telemetry_events with hashed session_id and stripped sessionId in payload", async () => {
    await postEvents([
      evt("tool_call", { tool: "ashlr__grep", rawBytes: 12000, compactBytes: 800, fellBack: false, providerUsed: "anthropic", durationMs: 320 }),
    ]);
    const rows = getDb()
      .query<{ session_id_hash: string; ts: number; kind: string; payload: string }, []>(
        "SELECT session_id_hash, ts, kind, payload FROM telemetry_events ORDER BY id",
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("tool_call");
    // session_id_hash MUST NOT equal the raw sessionId (it's a SHA-256 fold).
    expect(rows[0]!.session_id_hash).not.toBe(SID);
    expect(rows[0]!.session_id_hash.length).toBe(32);
    // Payload should NOT redundantly carry sessionId.
    const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
    expect(payload.sessionId).toBeUndefined();
    expect(payload.tool).toBe("ashlr__grep");
  });

  it("accepts multi_turn_stale_estimate events (v1.25)", async () => {
    const res = await postEvents([
      evt("multi_turn_stale_estimate", { sessionTurnCount: 12, staleBytes: 51200, staleResults: 4 }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(1);
    const row = getDb()
      .query<{ kind: string; payload: string }, []>(
        "SELECT kind, payload FROM telemetry_events ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(row!.kind).toBe("multi_turn_stale_estimate");
    const payload = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(payload.sessionTurnCount).toBe(12);
    expect(payload.staleBytes).toBe(51200);
    expect(payload.staleResults).toBe(4);
  });

  it("empty events array returns accepted=0 without DB writes", async () => {
    const res = await postEvents([]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(0);
    const count = getDb()
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_events")
      .get();
    expect(count!.n).toBe(0);
  });
});

describe("POST /v1/events — privacy regression (looksLikePath)", () => {
  beforeEach(() => {
    _clearSlidingWindows();
    getDb().exec("DELETE FROM telemetry_events");
  });

  it("drops events whose payload values contain POSIX absolute paths", async () => {
    const res = await postEvents([
      evt("tool_call", { tool: "ashlr__read", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "anthropic", durationMs: 1, leakedPath: "/Users/masonwyatt/secret.txt" }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(0); // Dropped server-side
    const count = getDb().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_events").get();
    expect(count!.n).toBe(0);
  });

  it("drops events whose payload values contain Windows absolute paths", async () => {
    const res = await postEvents([
      evt("tool_call", { tool: "ashlr__read", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "anthropic", durationMs: 1, leak: "C:\\Users\\me\\file.ts" }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(0);
  });

  it("drops events whose payload values contain UNC paths", async () => {
    const res = await postEvents([
      evt("tool_call", { tool: "ashlr__read", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "anthropic", durationMs: 1, leak: "\\\\server\\share" }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(0);
  });

  it("accepts the rest of the batch when only some events carry paths", async () => {
    const res = await postEvents([
      evt("tool_call", { tool: "ashlr__read", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "anthropic", durationMs: 1 }),
      evt("tool_call", { tool: "ashlr__read", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "anthropic", durationMs: 1, leak: "/etc/passwd" }),
      evt("version", { pluginVersion: "1.23.0", bunVersion: "1.3.10", platform: "darwin", arch: "arm64" }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(2); // First + third; middle dropped
  });

  it("looksLikePath unit: short strings, relative paths, identifiers all return false", () => {
    expect(looksLikePath("")).toBe(false);
    expect(looksLikePath("/")).toBe(false); // length < 3
    expect(looksLikePath("hi")).toBe(false);
    expect(looksLikePath("ashlr__read")).toBe(false);
    expect(looksLikePath("src/index.ts")).toBe(false); // relative
    expect(looksLikePath("anthropic")).toBe(false);
    expect(looksLikePath("0123456789abcdef")).toBe(false); // sessionId-shaped
  });
});

describe("POST /v1/events — schema validation", () => {
  beforeEach(() => {
    _clearSlidingWindows();
    getDb().exec("DELETE FROM telemetry_events");
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects missing sessionId with 400", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [evt("tool_call", { tool: "x", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "n", durationMs: 1 })] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown event kind with 400", async () => {
    const res = await postEvents([evt("evil-kind" as never, { foo: "bar" })]);
    expect(res.status).toBe(400);
  });

  it("rejects negative ts with 400", async () => {
    const res = await postEvents([evt("tool_call", { tool: "x", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "n", durationMs: 1 }, -1)]);
    expect(res.status).toBe(400);
  });

  it("rejects batches > 500 events with 400", async () => {
    const big = Array.from({ length: 501 }, () => evt("tool_call", { tool: "x", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "n", durationMs: 1 }));
    const res = await postEvents(big);
    expect(res.status).toBe(400);
  });

  it("drops events whose per-event sessionId disagrees with batch sessionId", async () => {
    const evtWithMismatch = { ts: Math.floor(Date.now() / 1000), kind: "tool_call", sessionId: "DIFFERENT_ID_xx", tool: "x", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "n", durationMs: 1 };
    const res = await postEvents([evtWithMismatch]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(0);
  });
});

describe("POST /v1/events — rate limiting", () => {
  beforeEach(() => {
    _clearSlidingWindows();
    getDb().exec("DELETE FROM telemetry_events");
  });

  it("returns 429 after 10 requests / minute / session", async () => {
    // 10 POSTs of 1 event each — all accepted.
    for (let i = 0; i < 10; i++) {
      const r = await postEvents([evt("tool_call", { tool: "x", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "n", durationMs: 1 })]);
      expect(r.status).toBe(200);
    }
    // 11th POST — limit exceeded.
    const limited = await postEvents([evt("tool_call", { tool: "x", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "n", durationMs: 1 })]);
    expect(limited.status).toBe(429);
  });

  it("rate limit is per session-hash — different sessionIds get independent buckets", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await postEvents([evt("tool_call", { tool: "x", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "n", durationMs: 1 })]);
      expect(r.status).toBe(200);
    }
    // Different sessionId — fresh bucket.
    const otherSid = "fedcba9876543210";
    const ok2 = await app.fetch(
      new Request("http://localhost/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: otherSid,
          events: [{ ts: Math.floor(Date.now() / 1000), kind: "tool_call", sessionId: otherSid, tool: "y", rawBytes: 1, compactBytes: 1, fellBack: false, providerUsed: "n", durationMs: 1 }],
        }),
      }),
    );
    expect(ok2.status).toBe(200);
  });
});
