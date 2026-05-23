/**
 * wadd-client.test.ts
 *
 * Covers the client-side WAD-D (weekly-active-developers-using-it-daily)
 * instrumentation:
 *   - _stats.ts schema enrichment (user_first_active_at, user_last_active_at,
 *     daily_active) + idempotent daily heartbeat trigger from recordSaving.
 *   - _identity-hash.ts: stable machine_id + quarterly salt rotation.
 *   - _telemetry.ts emitDailyHeartbeat() honors the telemetry consent gate.
 *
 * Test isolation: each test runs in a fresh $HOME tmp dir with synchronous
 * stats writes (ASHLR_STATS_SYNC=1) so we can assert on-disk state without
 * sleeping for the debounce.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  _drainWrites,
  _resetMemCache,
  _resetWriteCount,
  recordSaving,
  statsPath,
  type StatsFile,
} from "../servers/_stats";

import {
  getIdentityHash,
  getOrCreateMachineId,
  machineIdPath,
  quarterlySalt,
} from "../servers/_identity-hash";

import {
  _resetDailyHeartbeatMemo,
  _setDailyHeartbeatFetch,
  _setDailyHeartbeatUrl,
} from "../servers/_telemetry";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let home: string;
const originalHome = process.env.HOME;
const originalSync = process.env.ASHLR_STATS_SYNC;
const originalTelem = process.env.ASHLR_TELEMETRY;
const originalSession = process.env.CLAUDE_SESSION_ID;
const originalApi = process.env.ASHLR_API_URL;

// Captured POSTs to the heartbeat endpoint.
let heartbeatCalls: Array<{ url: string; body: unknown }> = [];

function mockHeartbeatFetch(): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    let body: unknown = null;
    if (init?.body && typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    heartbeatCalls.push({ url: u, body });
    return new Response("ok", { status: 204 });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-wadd-"));
  mkdirSync(join(home, ".ashlr"), { recursive: true });
  process.env.HOME = home;
  process.env.ASHLR_STATS_SYNC = "1";
  // Default consent ON for most tests — the consent-gate test toggles this off.
  process.env.ASHLR_TELEMETRY = "on";
  delete process.env.CLAUDE_SESSION_ID;

  heartbeatCalls = [];
  _setDailyHeartbeatUrl("http://mock.local/stats/daily-active");
  _setDailyHeartbeatFetch(mockHeartbeatFetch());
  _resetDailyHeartbeatMemo();
  _resetMemCache();
  _resetWriteCount();
});

afterEach(async () => {
  await _drainWrites();
  _setDailyHeartbeatUrl(null);
  _setDailyHeartbeatFetch(null);
  _resetDailyHeartbeatMemo();
  _resetMemCache();
  await rm(home, { recursive: true, force: true });
  if (originalHome !== undefined) process.env.HOME = originalHome; else delete process.env.HOME;
  if (originalSync !== undefined) process.env.ASHLR_STATS_SYNC = originalSync; else delete process.env.ASHLR_STATS_SYNC;
  if (originalTelem !== undefined) process.env.ASHLR_TELEMETRY = originalTelem; else delete process.env.ASHLR_TELEMETRY;
  if (originalSession !== undefined) process.env.CLAUDE_SESSION_ID = originalSession; else delete process.env.CLAUDE_SESSION_ID;
  if (originalApi !== undefined) process.env.ASHLR_API_URL = originalApi; else delete process.env.ASHLR_API_URL;
});

async function readStatsFromDisk(): Promise<StatsFile> {
  const raw = await readFile(statsPath(), "utf-8");
  return JSON.parse(raw) as StatsFile;
}

async function waitForHeartbeat(timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (heartbeatCalls.length > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function todayUtc(): string { return new Date().toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
// _identity-hash
// ---------------------------------------------------------------------------

describe("getOrCreateMachineId", () => {
  test("creates a stable UUID on first call and reuses it on subsequent calls", () => {
    const a = getOrCreateMachineId(home);
    const b = getOrCreateMachineId(home);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
    expect(existsSync(machineIdPath(home))).toBe(true);
  });
});

describe("quarterlySalt", () => {
  test("rotates by UTC quarter", () => {
    expect(quarterlySalt(new Date(Date.UTC(2026, 0, 15)))).toBe("salt_2026Q1");
    expect(quarterlySalt(new Date(Date.UTC(2026, 3, 1)))).toBe("salt_2026Q2");
    expect(quarterlySalt(new Date(Date.UTC(2026, 6, 15)))).toBe("salt_2026Q3");
    expect(quarterlySalt(new Date(Date.UTC(2026, 9, 31)))).toBe("salt_2026Q4");
  });
});

describe("getIdentityHash", () => {
  test("returns 64-char lowercase hex hashes and stable across calls in the same quarter", () => {
    const now = new Date(Date.UTC(2026, 4, 22)); // 2026-05-22 → Q2
    const a = getIdentityHash({ now, homeDir: home });
    const b = getIdentityHash({ now, homeDir: home });
    expect(a.machineHash).toBe(b.machineHash);
    expect(a.machineHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.githubHash).toBeNull();
  });

  test("changes between quarters for the same machine_id (salt rotation)", () => {
    // First call seeds the machine_id file.
    const q2 = getIdentityHash({ now: new Date(Date.UTC(2026, 4, 22)), homeDir: home });
    const q3 = getIdentityHash({ now: new Date(Date.UTC(2026, 7, 1)),  homeDir: home });
    // Same machine_id (file persists) but different salt → different hash.
    const idFile = readFileSync(machineIdPath(home), "utf-8").trim();
    expect(idFile.length).toBeGreaterThan(0);
    expect(q2.machineHash).not.toBe(q3.machineHash);
  });

  test("derives githubHash from pro-token-cache when valid signed-in user", () => {
    writeFileSync(
      join(home, ".ashlr", "pro-token-cache.json"),
      JSON.stringify({
        valid: true,
        plan: "pro",
        trialEndsAt: null,
        validatedAt: new Date().toISOString(),
        githubLogin: "octocat",
      }),
    );
    const r = getIdentityHash({ now: new Date(Date.UTC(2026, 4, 22)), homeDir: home });
    expect(r.githubHash).not.toBeNull();
    expect(r.githubHash!).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// _stats.ts WAD-D enrichment + heartbeat trigger
// ---------------------------------------------------------------------------

describe("recordSaving — WAD-D schema enrichment", () => {
  test("first-ever call sets user_first_active_at, user_last_active_at, today's daily_active, and fires heartbeat once", async () => {
    await recordSaving(2000, 200, "ashlr__grep");
    await _drainWrites();

    const s = await readStatsFromDisk();
    expect(typeof s.user_first_active_at).toBe("string");
    expect(typeof s.user_last_active_at).toBe("string");
    const today = todayUtc();
    expect(s.daily_active && s.daily_active[today]).toBe(true);

    await waitForHeartbeat();
    expect(heartbeatCalls.length).toBe(1);
    const body = heartbeatCalls[0].body as Record<string, unknown>;
    expect(body.date).toBe(today);
    expect(body.identity_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.github_hash).toBeNull();
    expect(typeof body.plugin_version).toBe("string");
  });

  test("second same-day call: daily_active unchanged, user_last_active_at advances, NO new heartbeat", async () => {
    await recordSaving(2000, 200, "ashlr__grep");
    await _drainWrites();
    await waitForHeartbeat();
    expect(heartbeatCalls.length).toBe(1);

    const firstSnapshot = await readStatsFromDisk();
    const firstActive  = firstSnapshot.user_first_active_at!;
    const firstLastIso = firstSnapshot.user_last_active_at!;

    // Wait a tiny bit so the next ISO timestamp differs.
    await new Promise((r) => setTimeout(r, 5));
    await recordSaving(2000, 200, "ashlr__grep");
    await _drainWrites();

    const s = await readStatsFromDisk();
    // first_active_at frozen
    expect(s.user_first_active_at).toBe(firstActive);
    // last_active_at advanced
    expect(new Date(s.user_last_active_at!).getTime()).toBeGreaterThanOrEqual(new Date(firstLastIso).getTime());
    // daily_active is still exactly {today: true}
    expect(Object.keys(s.daily_active ?? {})).toEqual([todayUtc()]);
    // No second heartbeat
    expect(heartbeatCalls.length).toBe(1);
  });

  test("next-day call (simulated via stats.json injection) writes a new daily_active entry and refires heartbeat", async () => {
    // Seed stats.json with a "yesterday" daily_active entry as if the
    // previous day's heartbeat already fired. The current process has
    // _resetDailyHeartbeatMemo() applied in beforeEach so an in-process
    // re-emit is allowed for today.
    const yesterday = "2020-01-01"; // far in the past so today != yesterday
    const seed: StatsFile = {
      schemaVersion: 2,
      sessions: {},
      lifetime: { calls: 1, tokensSaved: 100, rawTotal: 500, byTool: {}, byDay: { [yesterday]: { calls: 1, tokensSaved: 100 } } },
      user_first_active_at: "2020-01-01T00:00:00.000Z",
      user_last_active_at: "2020-01-01T00:00:00.000Z",
      daily_active: { [yesterday]: true },
    };
    writeFileSync(statsPath(), JSON.stringify(seed));
    _resetMemCache();

    await recordSaving(4000, 400, "ashlr__grep");
    await _drainWrites();

    const s = await readStatsFromDisk();
    expect(s.daily_active && s.daily_active[yesterday]).toBe(true);
    expect(s.daily_active && s.daily_active[todayUtc()]).toBe(true);
    // user_first_active_at must NOT be overwritten by today's call.
    expect(s.user_first_active_at).toBe("2020-01-01T00:00:00.000Z");

    await waitForHeartbeat();
    expect(heartbeatCalls.length).toBe(1);
    expect((heartbeatCalls[0].body as Record<string, unknown>).date).toBe(todayUtc());
  });

  test("migration: older stats.json without WAD-D fields still works and gets populated", async () => {
    // Pre-WAD-D shape on disk.
    const legacy = {
      schemaVersion: 2,
      sessions: {},
      lifetime: { calls: 5, tokensSaved: 500, rawTotal: 2500, byTool: {}, byDay: {} },
    };
    writeFileSync(statsPath(), JSON.stringify(legacy));
    _resetMemCache();

    await recordSaving(1000, 100, "ashlr__grep");
    await _drainWrites();

    const s = await readStatsFromDisk();
    expect(typeof s.user_first_active_at).toBe("string");
    expect(typeof s.user_last_active_at).toBe("string");
    expect(s.daily_active && s.daily_active[todayUtc()]).toBe(true);
    // lifetime numbers preserved from the legacy file (5 + 1 = 6).
    expect(s.lifetime.calls).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Consent gate
// ---------------------------------------------------------------------------

describe("emitDailyHeartbeat — consent gate", () => {
  test("does NOT POST when ASHLR_TELEMETRY=off", async () => {
    process.env.ASHLR_TELEMETRY = "off";

    await recordSaving(2000, 200, "ashlr__grep");
    await _drainWrites();
    // Give the fire-and-forget chain a tick to run if it were going to.
    await new Promise((r) => setTimeout(r, 50));

    expect(heartbeatCalls.length).toBe(0);

    // But the on-disk WAD-D fields are still tracked locally — privacy gate
    // only blocks the *network* side. Local stats remain accurate so the
    // user keeps their own savings counters intact.
    const s = await readStatsFromDisk();
    expect(s.daily_active && s.daily_active[todayUtc()]).toBe(true);
  });
});
