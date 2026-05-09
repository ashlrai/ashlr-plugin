/**
 * telemetry-track1.test.ts — v1.30 Track 1 telemetry changes.
 *
 * Coverage:
 *   1.1 — tool_call accepts tool_name field; also accepts without (backward-compat).
 *   1.2 — hook_perf event kind accepted and persisted.
 *   1.3 — genome_compression_ratio event kind accepted and persisted.
 *   1.5 — multi_turn_stale_estimate rejected (removed from schema).
 *   Bonus — wizard_step event kind accepted (Track 3 coordination).
 *   1.4 — admin dashboard queries return expected shape on synthetic data.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import app from "../src/index.js";
import { _clearSlidingWindows } from "../src/lib/ratelimit.js";
import { getDb } from "../src/db.js";
import { adminGetToolAdoption, adminGetHookLatency, adminGetGenomeCompressionTrend } from "../src/db.js";

const SID = "abcdef0123456789";

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

function cleanTelemetry() {
  _clearSlidingWindows();
  getDb().exec("DELETE FROM telemetry_events");
}

// ---------------------------------------------------------------------------
// 1.1 — tool_name field
// ---------------------------------------------------------------------------

describe("1.1 — tool_call with tool_name", () => {
  beforeEach(cleanTelemetry);

  it("accepts tool_call WITH tool_name (new clients)", async () => {
    const res = await postEvents([
      evt("tool_call", {
        tool: "ashlr__grep",
        tool_name: "ashlr__grep",
        rawBytes: 8000,
        compactBytes: 900,
        fellBack: false,
        providerUsed: "local",
        durationMs: 50,
      }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(1);

    const row = getDb()
      .query<{ payload: string }, []>("SELECT payload FROM telemetry_events LIMIT 1")
      .get();
    expect(row).toBeTruthy();
    const payload = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(payload.tool_name).toBe("ashlr__grep");
  });

  it("accepts tool_call WITHOUT tool_name (backward-compat with pre-v1.30 clients)", async () => {
    const res = await postEvents([
      evt("tool_call", {
        tool: "ashlr__read",
        rawBytes: 5000,
        compactBytes: 600,
        fellBack: false,
        providerUsed: "local",
        durationMs: 30,
      }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 1.2 — hook_perf event kind
// ---------------------------------------------------------------------------

describe("1.2 — hook_perf event kind", () => {
  beforeEach(cleanTelemetry);

  it("accepts hook_perf event and persists all fields", async () => {
    const res = await postEvents([
      evt("hook_perf", {
        hook_name: "pretooluse-grep",
        p50_ms: 12,
        p99_ms: 45,
        count: 38,
      }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(1);

    const row = getDb()
      .query<{ kind: string; payload: string }, []>(
        "SELECT kind, payload FROM telemetry_events ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(row!.kind).toBe("hook_perf");
    const payload = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(payload.hook_name).toBe("pretooluse-grep");
    expect(payload.p50_ms).toBe(12);
    expect(payload.p99_ms).toBe(45);
    expect(payload.count).toBe(38);
  });
});

// ---------------------------------------------------------------------------
// 1.3 — genome_compression_ratio event kind
// ---------------------------------------------------------------------------

describe("1.3 — genome_compression_ratio event kind", () => {
  beforeEach(cleanTelemetry);

  it("accepts genome_compression_ratio event and persists fields", async () => {
    const res = await postEvents([
      evt("genome_compression_ratio", {
        tool: "ashlr__grep",
        raw_bytes: 48000,
        compressed_bytes: 3200,
      }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(1);

    const row = getDb()
      .query<{ kind: string; payload: string }, []>(
        "SELECT kind, payload FROM telemetry_events ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(row!.kind).toBe("genome_compression_ratio");
    const payload = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(payload.tool).toBe("ashlr__grep");
    expect(payload.raw_bytes).toBe(48000);
    expect(payload.compressed_bytes).toBe(3200);
  });
});

// ---------------------------------------------------------------------------
// 1.5 — multi_turn_stale_estimate removed
// ---------------------------------------------------------------------------

describe("1.5 — multi_turn_stale_estimate rejected", () => {
  beforeEach(cleanTelemetry);

  it("rejects multi_turn_stale_estimate with 400 (removed in v1.30)", async () => {
    const res = await postEvents([
      evt("multi_turn_stale_estimate" as never, { sessionTurnCount: 5, staleBytes: 1024, staleResults: 2 }),
    ]);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Bonus — wizard_step (Track 3 coordination)
// ---------------------------------------------------------------------------

describe("Bonus — wizard_step event kind (Track 3 coordination)", () => {
  beforeEach(cleanTelemetry);

  it("accepts wizard_step with completed outcome", async () => {
    const res = await postEvents([
      evt("wizard_step", { step_name: "status-line", outcome: "completed" }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(1);

    const row = getDb()
      .query<{ kind: string; payload: string }, []>(
        "SELECT kind, payload FROM telemetry_events ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(row!.kind).toBe("wizard_step");
    const payload = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(payload.step_name).toBe("status-line");
    expect(payload.outcome).toBe("completed");
  });

  it("accepts wizard_step with skipped outcome", async () => {
    const res = await postEvents([
      evt("wizard_step", { step_name: "genome-init", outcome: "skipped" }),
    ]);
    expect(res.status).toBe(200);
  });

  it("accepts wizard_step with error outcome", async () => {
    const res = await postEvents([
      evt("wizard_step", { step_name: "doctor", outcome: "error" }),
    ]);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 1.4 — Admin dashboard queries shape
// ---------------------------------------------------------------------------

describe("1.4 — admin dashboard queries", () => {
  beforeEach(() => {
    cleanTelemetry();

    // Insert synthetic tool_call events (mix of tool names)
    const db = getDb();
    const nowTs = Math.floor(Date.now() / 1000);
    const insertEvt = db.prepare(
      "INSERT INTO telemetry_events (session_id_hash, ts, kind, payload) VALUES (?, ?, ?, ?)",
    );
    const tx = db.transaction(() => {
      // 5x ashlr__grep, 3x ashlr__read, 2x ashlr__edit (no tool_name — backward compat)
      for (let i = 0; i < 5; i++) {
        insertEvt.run("hash1", nowTs - i, "tool_call", JSON.stringify({ tool: "ashlr__grep", tool_name: "ashlr__grep" }));
      }
      for (let i = 0; i < 3; i++) {
        insertEvt.run("hash2", nowTs - i, "tool_call", JSON.stringify({ tool: "ashlr__read", tool_name: "ashlr__read" }));
      }
      for (let i = 0; i < 2; i++) {
        insertEvt.run("hash3", nowTs - i, "tool_call", JSON.stringify({ tool: "ashlr__edit" })); // no tool_name
      }
      // hook_perf events
      insertEvt.run("hash1", nowTs, "hook_perf", JSON.stringify({ hook_name: "pretooluse-grep", p50_ms: 10, p99_ms: 40, count: 20 }));
      insertEvt.run("hash1", nowTs - 1, "hook_perf", JSON.stringify({ hook_name: "pretooluse-read", p50_ms: 5, p99_ms: 20, count: 15 }));
      // genome_compression_ratio events
      insertEvt.run("hash1", nowTs, "genome_compression_ratio", JSON.stringify({ tool: "ashlr__grep", raw_bytes: 50000, compressed_bytes: 2500 }));
      insertEvt.run("hash1", nowTs - 1, "genome_compression_ratio", JSON.stringify({ tool: "ashlr__grep", raw_bytes: 40000, compressed_bytes: 2000 }));
    });
    tx();
  });

  it("adminGetToolAdoption returns rows with tool_name and share_pct", () => {
    const rows = adminGetToolAdoption(24);
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // ashlr__grep should be the top tool (5 calls out of 10 = 50%)
    const grep = rows.find((r) => r.tool_name === "ashlr__grep");
    expect(grep).toBeTruthy();
    expect(grep!.call_count).toBe(5);
    expect(grep!.share_pct).toBeCloseTo(50, 0);

    // sum of all share_pct should be ~100
    const total = rows.reduce((s, r) => s + r.share_pct, 0);
    expect(total).toBeCloseTo(100, 0);
  });

  it("adminGetToolAdoption groups missing tool_name as (unknown)", () => {
    const rows = adminGetToolAdoption(24);
    const unknown = rows.find((r) => r.tool_name === "(unknown)");
    // ashlr__edit rows have no tool_name
    expect(unknown).toBeTruthy();
    expect(unknown!.call_count).toBe(2);
  });

  it("adminGetHookLatency returns p50/p99 per hook", () => {
    const rows = adminGetHookLatency(24);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const grep = rows.find((r) => r.hook_name === "pretooluse-grep");
    expect(grep).toBeTruthy();
    expect(grep!.p50_ms).toBe(10);
    expect(grep!.p99_ms).toBe(40);
    expect(grep!.sample_count).toBe(1);

    // Result should have the required shape fields
    for (const r of rows) {
      expect(typeof r.hook_name).toBe("string");
      expect(typeof r.p50_ms).toBe("number");
      expect(typeof r.p99_ms).toBe("number");
      expect(typeof r.sample_count).toBe("number");
    }
  });

  it("adminGetGenomeCompressionTrend returns daily ratio", () => {
    const rows = adminGetGenomeCompressionTrend(720);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const today = rows[0]!;
    expect(typeof today.day).toBe("string");
    expect(today.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // avg ratio: (2500/50000 + 2000/40000) / 2 = (0.05 + 0.05) / 2 = 0.05
    expect(today.median_ratio).toBeCloseTo(0.05, 2);
    expect(today.sample_count).toBe(2);
  });
});
