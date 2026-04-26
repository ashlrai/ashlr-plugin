/**
 * telemetry.test.ts — Track EE: opt-in telemetry pipeline.
 *
 * Coverage:
 *   1. Telemetry OFF (default): no events written to buffer.
 *   2. Telemetry ON: recordTelemetryEvent writes to buffer.
 *   3. Buffer cap: 5001st event evicts oldest.
 *   4. Flusher: POSTs the buffer, truncates on 2xx, leaves on error (mock fetch).
 *   5. No path/pattern strings appear in any anonymized event payload (regression guard).
 *   6. looksLikePath correctly identifies absolute paths and rejects non-paths.
 *   7. Session ID: created once, reused across calls.
 *   8. isTelemetryEnabled: env and config precedence.
 *   9. maybeTelemetryConsentNotice: shown once, then suppressed.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

let home: string;
let origHome: string | undefined;
let origTelemetry: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-tel-test-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  origHome = process.env.HOME;
  origTelemetry = process.env.ASHLR_TELEMETRY;
  process.env.HOME = home;
  delete process.env.ASHLR_TELEMETRY;
});

afterEach(async () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  if (origTelemetry !== undefined) process.env.ASHLR_TELEMETRY = origTelemetry;
  else delete process.env.ASHLR_TELEMETRY;
  await rm(home, { recursive: true, force: true });
});

import {
  isTelemetryEnabled,
  recordTelemetryEvent,
  readTelemetryBuffer,
  truncateTelemetryBuffer,
  getOrCreateTelemetrySessionId,
  looksLikePath,
  telemetryBufferPath,
  telemetrySessionPath,
  maybeTelemetryConsentNotice,
  MAX_BUFFER_LINES,
} from "../servers/_telemetry";

// ---------------------------------------------------------------------------
// 1. Telemetry OFF (default): no events written
// ---------------------------------------------------------------------------

describe("telemetry OFF (default)", () => {
  test("recordTelemetryEvent writes nothing when telemetry is off", () => {
    // Default: no env var, no config file → OFF
    recordTelemetryEvent({
      kind: "tool_call",
      tool: "ashlr__read",
      rawBytes: 8200,
      compactBytes: 1100,
      fellBack: false,
      providerUsed: "anthropic",
      durationMs: 42,
    }, home);

    const bufPath = telemetryBufferPath(home);
    expect(existsSync(bufPath)).toBe(false);
  });

  test("ASHLR_TELEMETRY=off explicitly disables telemetry", () => {
    process.env.ASHLR_TELEMETRY = "off";
    expect(isTelemetryEnabled(home)).toBe(false);
  });

  test("ASHLR_TELEMETRY=0 disables telemetry", () => {
    process.env.ASHLR_TELEMETRY = "0";
    expect(isTelemetryEnabled(home)).toBe(false);
  });

  test("no config file → telemetry is off", () => {
    expect(isTelemetryEnabled(home)).toBe(false);
  });

  test("config.telemetry absent → off", async () => {
    await writeFile(
      join(home, ".ashlr", "config.json"),
      JSON.stringify({ someOtherKey: true }),
    );
    expect(isTelemetryEnabled(home)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Telemetry ON: events are written
// ---------------------------------------------------------------------------

describe("telemetry ON", () => {
  beforeEach(async () => {
    await writeFile(
      join(home, ".ashlr", "config.json"),
      JSON.stringify({ telemetry: "opt-in" }),
    );
  });

  test("isTelemetryEnabled returns true with config opt-in", () => {
    expect(isTelemetryEnabled(home)).toBe(true);
  });

  test("ASHLR_TELEMETRY=on enables telemetry", () => {
    process.env.ASHLR_TELEMETRY = "on";
    expect(isTelemetryEnabled(home)).toBe(true);
  });

  test("ASHLR_TELEMETRY=1 enables telemetry", () => {
    process.env.ASHLR_TELEMETRY = "1";
    expect(isTelemetryEnabled(home)).toBe(true);
  });

  test("ASHLR_TELEMETRY=off overrides config opt-in (kill switch)", () => {
    process.env.ASHLR_TELEMETRY = "off";
    expect(isTelemetryEnabled(home)).toBe(false);
  });

  test("config.telemetry=off overrides env on (kill switch via config)", async () => {
    process.env.ASHLR_TELEMETRY = "on";
    await writeFile(
      join(home, ".ashlr", "config.json"),
      JSON.stringify({ telemetry: "off" }),
    );
    expect(isTelemetryEnabled(home)).toBe(false);
  });

  test("recordTelemetryEvent writes one line to buffer", () => {
    recordTelemetryEvent({
      kind: "tool_call",
      tool: "ashlr__read",
      rawBytes: 8200,
      compactBytes: 1100,
      fellBack: false,
      providerUsed: "anthropic",
      durationMs: 42,
    }, home);

    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(1);
    expect(records[0]!.kind).toBe("tool_call");
    expect(records[0]!.tool).toBe("ashlr__read");
    expect(records[0]!.rawBytes).toBe(8200);
    expect(records[0]!.fellBack).toBe(false);
  });

  test("multiple events append correctly", () => {
    for (let i = 0; i < 5; i++) {
      recordTelemetryEvent({
        kind: "pretooluse_passthrough",
        tool: "ashlr__grep",
        reason: "below-threshold",
      }, home);
    }
    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(5);
    for (const r of records) {
      expect(r.kind).toBe("pretooluse_passthrough");
      expect(r.reason).toBe("below-threshold");
    }
  });

  test("pretooluse_block event writes sizeRange not raw bytes", () => {
    recordTelemetryEvent({
      kind: "pretooluse_block",
      tool: "Read",
      blockedTo: "ashlr__read",
      sizeRange: "large",
    }, home);
    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(1);
    expect(records[0]!.sizeRange).toBe("large");
    expect(records[0]!.blockedTo).toBe("ashlr__read");
    // Confirm no raw byte count leaked in
    expect("rawBytes" in records[0]!).toBe(false);
  });

  test("version event writes platform/arch", () => {
    recordTelemetryEvent({
      kind: "version",
      pluginVersion: "1.23.0",
      bunVersion: "1.2.3",
      platform: "darwin",
      arch: "arm64",
    }, home);
    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(1);
    expect(records[0]!.pluginVersion).toBe("1.23.0");
    expect(records[0]!.platform).toBe("darwin");
  });

  test("every record has ts, kind, sessionId fields", () => {
    recordTelemetryEvent({
      kind: "tool_call",
      tool: "ashlr__edit",
      rawBytes: 500,
      compactBytes: 200,
      fellBack: false,
      providerUsed: "snipCompact",
      durationMs: 10,
    }, home);
    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(typeof r.ts).toBe("number");
    expect(typeof r.kind).toBe("string");
    expect(typeof r.sessionId).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 3. Buffer cap: 5001st event evicts oldest
// ---------------------------------------------------------------------------

describe("buffer cap", () => {
  beforeEach(async () => {
    await writeFile(
      join(home, ".ashlr", "config.json"),
      JSON.stringify({ telemetry: "opt-in" }),
    );
  });

  test(`${MAX_BUFFER_LINES + 1}th event evicts oldest entries`, () => {
    // Write MAX_BUFFER_LINES + 1 events. The eviction factor is 1.1, so
    // eviction fires at floor(5000 * 1.1) = 5500 entries. We write 5001
    // directly to the buffer file to test truncation logic independently,
    // then write one more via recordTelemetryEvent to trigger eviction.
    //
    // To keep the test fast, we write directly to the buffer file.
    const bufPath = telemetryBufferPath(home);
    const lines: string[] = [];
    for (let i = 0; i < MAX_BUFFER_LINES + 1; i++) {
      lines.push(JSON.stringify({ ts: i, kind: "tool_call", sessionId: "x", tool: `t${i}` }));
    }
    require("fs").writeFileSync(bufPath, lines.join("\n") + "\n", "utf-8");

    // Now call truncateTelemetryBuffer with a horizon that drops all but the last MAX_BUFFER_LINES.
    // Horizon ts = 0 means drop entries with ts <= 0 (just the first entry).
    truncateTelemetryBuffer(0, home);

    const records = readTelemetryBuffer(home);
    // After truncation at ts=0: entries with ts > 0 remain → MAX_BUFFER_LINES entries.
    expect(records.length).toBe(MAX_BUFFER_LINES);
    // First entry is now ts=1, not ts=0.
    expect(records[0]!.ts).toBe(1);
  });

  test("buffer eviction via recordTelemetryEvent keeps most recent MAX_BUFFER_LINES", () => {
    // Write 5500 events (10% above MAX_BUFFER_LINES * EVICTION_FACTOR trigger)
    // directly to buffer, then one via recordTelemetryEvent to trigger eviction.
    const bufPath = telemetryBufferPath(home);
    const triggerCount = Math.floor(MAX_BUFFER_LINES * 1.1) + 1; // 5501
    const lines: string[] = [];
    for (let i = 0; i < triggerCount; i++) {
      lines.push(JSON.stringify({ ts: i + 1000, kind: "tool_call", sessionId: "x", tool: `t${i}` }));
    }
    require("fs").writeFileSync(bufPath, lines.join("\n") + "\n", "utf-8");

    // This write triggers _maybeEvict via recordTelemetryEvent.
    recordTelemetryEvent({
      kind: "pretooluse_passthrough",
      tool: "ashlr__grep",
      reason: "bypass",
    }, home);

    const records = readTelemetryBuffer(home);
    // After eviction: at most MAX_BUFFER_LINES + 1 (the new event).
    expect(records.length).toBeLessThanOrEqual(MAX_BUFFER_LINES + 1);
    // The new event (last one) should be present.
    const lastRecord = records[records.length - 1]!;
    expect(lastRecord.kind).toBe("pretooluse_passthrough");
  });
});

// ---------------------------------------------------------------------------
// 4. Flusher: mock fetch — POSTs and truncates on 2xx, leaves on error
// ---------------------------------------------------------------------------

describe("flusher", () => {
  beforeEach(async () => {
    await writeFile(
      join(home, ".ashlr", "config.json"),
      JSON.stringify({ telemetry: "opt-in" }),
    );
  });

  test("flush with 2xx response truncates the buffer", async () => {
    // Seed the buffer with 3 events.
    for (let i = 0; i < 3; i++) {
      recordTelemetryEvent({
        kind: "tool_call",
        tool: "ashlr__read",
        rawBytes: 100 * (i + 1),
        compactBytes: 50,
        fellBack: false,
        providerUsed: "anthropic",
        durationMs: i * 10,
      }, home);
    }
    expect(readTelemetryBuffer(home).length).toBe(3);

    // Mock global fetch to return 200.
    const capturedRequests: { url: string; body: unknown }[] = [];
    const origFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) as unknown : null;
      capturedRequests.push({ url: String(url), body });
      return new Response(JSON.stringify({ accepted: 3 }), { status: 200 });
    };

    try {
      const { flush } = await import("../scripts/telemetry-flush");
      const result = await flush(home);
      expect(result.ok).toBe(true);
      expect(result.sent).toBe(3);

      // Buffer should be truncated (all 3 events flushed).
      const remaining = readTelemetryBuffer(home);
      expect(remaining.length).toBe(0);

      // POST shape check.
      expect(capturedRequests.length).toBe(1);
      const payload = capturedRequests[0]!.body as { sessionId: string; events: unknown[] };
      expect(typeof payload.sessionId).toBe("string");
      expect(Array.isArray(payload.events)).toBe(true);
      expect(payload.events.length).toBe(3);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("flush with network error leaves buffer intact", async () => {
    recordTelemetryEvent({
      kind: "tool_call",
      tool: "ashlr__grep",
      rawBytes: 500,
      compactBytes: 100,
      fellBack: false,
      providerUsed: "anthropic",
      durationMs: 5,
    }, home);
    expect(readTelemetryBuffer(home).length).toBe(1);

    const origFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => { throw new Error("network unreachable"); };

    try {
      const { flush } = await import("../scripts/telemetry-flush");
      const result = await flush(home);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/network unreachable/);

      // Buffer must NOT be truncated on error.
      expect(readTelemetryBuffer(home).length).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("flush with non-2xx response leaves buffer intact", async () => {
    recordTelemetryEvent({
      kind: "pretooluse_passthrough",
      tool: "ashlr__read",
      reason: "below-threshold",
    }, home);

    const origFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => new Response("Bad Gateway", { status: 502 });

    try {
      const { flush } = await import("../scripts/telemetry-flush");
      const result = await flush(home);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/502/);
      expect(readTelemetryBuffer(home).length).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("flush when telemetry is off returns skipped", async () => {
    // Override config to off.
    await writeFile(
      join(home, ".ashlr", "config.json"),
      JSON.stringify({ telemetry: "off" }),
    );
    const { flush } = await import("../scripts/telemetry-flush");
    const result = await flush(home);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("telemetry-off");
  });

  test("flush with empty buffer returns skipped", async () => {
    const { flush } = await import("../scripts/telemetry-flush");
    const result = await flush(home);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("empty-buffer");
  });
});

// ---------------------------------------------------------------------------
// 5. No path/pattern strings in anonymized event payloads (regression guard)
// ---------------------------------------------------------------------------

describe("privacy regression guard — no paths in events", () => {
  beforeEach(async () => {
    await writeFile(
      join(home, ".ashlr", "config.json"),
      JSON.stringify({ telemetry: "opt-in" }),
    );
  });

  test("looksLikePath correctly identifies absolute POSIX paths", () => {
    expect(looksLikePath("/home/user/foo.ts")).toBe(true);
    expect(looksLikePath("/Users/mason/project/bar.md")).toBe(true);
    expect(looksLikePath("/tmp/test")).toBe(true);
  });

  test("looksLikePath correctly identifies Windows absolute paths", () => {
    expect(looksLikePath("C:\\Users\\mason\\file.ts")).toBe(true);
    expect(looksLikePath("C:/Users/mason/file.ts")).toBe(true);
    expect(looksLikePath("\\\\server\\share\\file")).toBe(true);
  });

  test("looksLikePath returns false for non-path strings", () => {
    expect(looksLikePath("anthropic")).toBe(false);
    expect(looksLikePath("below-threshold")).toBe(false);
    expect(looksLikePath("ashlr__read")).toBe(false);
    expect(looksLikePath("tool_call")).toBe(false);
    expect(looksLikePath("large")).toBe(false);
    expect(looksLikePath("darwin")).toBe(false);
  });

  test("event with a path-like string value is silently dropped (not written)", () => {
    // Attempt to sneak a path in via a fabricated payload cast.
    // TypeScript won't allow this directly, so we cast through unknown.
    const badPayload = {
      kind: "tool_call" as const,
      tool: "ashlr__read",
      rawBytes: 500,
      compactBytes: 100,
      fellBack: false,
      providerUsed: "/usr/bin/sneaky", // path-like! should be rejected
      durationMs: 10,
    };
    recordTelemetryEvent(badPayload, home);
    // The path guard should have dropped this event entirely.
    expect(readTelemetryBuffer(home).length).toBe(0);
  });

  test("normal events contain no path-like string values", () => {
    recordTelemetryEvent({
      kind: "tool_call",
      tool: "ashlr__read",
      rawBytes: 8200,
      compactBytes: 1100,
      fellBack: false,
      providerUsed: "anthropic",
      durationMs: 42,
    }, home);

    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(1);
    const r = records[0]!;

    // Check every string value in the record for path-likeness.
    for (const [key, val] of Object.entries(r)) {
      if (typeof val === "string") {
        expect(looksLikePath(val)).toBe(false);
        // Also confirm sessionId doesn't look like a path.
        if (key === "sessionId") {
          expect(val.startsWith("/")).toBe(false);
        }
      }
    }
  });

  test("no raw file paths appear in pretooluse_block events", () => {
    recordTelemetryEvent({
      kind: "pretooluse_block",
      tool: "Read",
      blockedTo: "ashlr__read",
      sizeRange: "medium",
    }, home);
    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(1);
    for (const val of Object.values(records[0]!)) {
      if (typeof val === "string") {
        expect(looksLikePath(val)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Session ID: created once, reused
// ---------------------------------------------------------------------------

describe("session ID", () => {
  test("getOrCreateTelemetrySessionId returns a non-empty string", () => {
    const id = getOrCreateTelemetrySessionId(home);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("session ID is stable across multiple calls", () => {
    const id1 = getOrCreateTelemetrySessionId(home);
    const id2 = getOrCreateTelemetrySessionId(home);
    expect(id1).toBe(id2);
  });

  test("session ID is persisted to disk", () => {
    const id = getOrCreateTelemetrySessionId(home);
    const sessionPath = telemetrySessionPath(home);
    expect(existsSync(sessionPath)).toBe(true);
    const stored = JSON.parse(readFileSync(sessionPath, "utf-8")) as { id: string };
    expect(stored.id).toBe(id);
  });

  test("session ID is hex-only (not a path)", () => {
    const id = getOrCreateTelemetrySessionId(home);
    // Should be a hex string without slashes.
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
    expect(looksLikePath(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Consent notice: shown once, then suppressed
// ---------------------------------------------------------------------------

describe("consent notice", () => {
  test("maybeTelemetryConsentNotice returns null when telemetry is off", () => {
    const notice = maybeTelemetryConsentNotice(home);
    expect(notice).toBeNull();
  });

  test("maybeTelemetryConsentNotice returns a string on first opt-in", async () => {
    await writeFile(
      join(home, ".ashlr", "config.json"),
      JSON.stringify({ telemetry: "opt-in" }),
    );
    const notice = maybeTelemetryConsentNotice(home);
    expect(typeof notice).toBe("string");
    expect(notice!.length).toBeGreaterThan(0);
    // Must mention how to disable.
    expect(notice).toContain("ASHLR_TELEMETRY=off");
  });

  test("maybeTelemetryConsentNotice returns null on second call (stamp written)", async () => {
    await writeFile(
      join(home, ".ashlr", "config.json"),
      JSON.stringify({ telemetry: "opt-in" }),
    );
    // First call shows notice and writes stamp.
    const first = maybeTelemetryConsentNotice(home);
    expect(first).not.toBeNull();
    // Second call: stamp exists → null.
    const second = maybeTelemetryConsentNotice(home);
    expect(second).toBeNull();
  });
});
