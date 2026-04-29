/**
 * stats-cloud-sync.test.ts
 *
 * Covers:
 *   - pushStatsToCloud: first sync (no cursor) → pushes everything
 *   - pushStatsToCloud: subsequent sync → skips when no delta
 *   - pushStatsToCloud: network error → cursor unchanged, error swallowed
 *   - pullAggregateStats: cache TTL respected
 *   - pullAggregateStats: returns stale cache on network error
 *   - maybeCloudSync: skips when no pro-token (free-tier)
 *   - maybeCloudPull: skips when no pro-token (free-tier)
 *   - Dashboard renderCrossMachine: renders cross-machine line when cache present + Pro token
 *   - Dashboard renderCrossMachine: silent when no pro-token
 *
 * All HTTP calls use a local Bun.serve() mock — no external network required.
 * Tests are isolated via tmp directories ($HOME override).
 *
 * Run with: ASHLR_STATS_SYNC=1 bun test __tests__/stats-cloud-sync.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  pushStatsToCloud,
  maybeCloudSync,
  readCursor,
  resolveProToken,
  machineId,
} from "../scripts/stats-cloud-sync.ts";

import {
  pullAggregateStats,
  maybeCloudPull,
  isCacheValid,
  readAggregateCache,
  CACHE_TTL_MS,
} from "../scripts/stats-cloud-pull.ts";

import { renderCrossMachine } from "../scripts/savings-dashboard.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockServer {
  url: string;
  syncCalls: Array<{ body: unknown }>;
  stop: () => void;
}

async function startMock(opts: {
  aggResponse?: object;
  aggStatus?: number;
  syncStatus?: number;
} = {}): Promise<MockServer> {
  const syncCalls: Array<{ body: unknown }> = [];
  const aggResponse = opts.aggResponse ?? {
    user_id: "u_test",
    lifetime_calls: 100,
    lifetime_tokens_saved: 50_000,
    by_tool: {},
    by_day: {},
    machine_count: 3,
  };
  const aggStatus = opts.aggStatus ?? 200;
  const syncStatus = opts.syncStatus ?? 200;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/stats/sync") {
        const body = await req.json().catch(() => null);
        syncCalls.push({ body });
        return Response.json({ ok: true }, { status: syncStatus });
      }
      if (req.method === "GET" && url.pathname === "/stats/aggregate") {
        if (aggStatus !== 200) {
          return new Response("error", { status: aggStatus });
        }
        return Response.json(aggResponse);
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    syncCalls,
    stop: () => server.stop(),
  };
}

// ---------------------------------------------------------------------------
// Test isolation — each test gets a fresh tmp directory as HOME.
// ---------------------------------------------------------------------------

let tmpHome: string;

function setupTmpHome(): void {
  tmpHome = mkdtempSync(join(tmpdir(), "ashlr-test-"));
  mkdirSync(join(tmpHome, ".ashlr"), { recursive: true });
  process.env["HOME"] = tmpHome;
}

function teardownTmpHome(): void {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ok */
  }
  delete process.env["HOME"];
  delete process.env["ASHLR_PRO_TOKEN"];
  delete process.env["ASHLR_API_URL"];
  delete process.env["ASHLR_STATS_UPLOAD"];
}

function writeProToken(token: string): void {
  writeFileSync(join(tmpHome, ".ashlr", "pro-token"), token);
}

function writeCursorFixture(calls: number, tokensSaved: number): void {
  writeFileSync(
    join(tmpHome, ".ashlr", "stats-sync-cursor.json"),
    JSON.stringify({ syncedAt: new Date().toISOString(), calls, tokensSaved }),
  );
}

function writeAggregateCacheFixture(data: object, ageMs = 0): void {
  const fetchedAt = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(
    join(tmpHome, ".ashlr", "stats-aggregate-cache.json"),
    JSON.stringify({ fetchedAt, data }),
  );
}

// ---------------------------------------------------------------------------
// machineId
// ---------------------------------------------------------------------------

describe("machineId", () => {
  it("returns a 16-char hex string", () => {
    const id = machineId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across calls", () => {
    expect(machineId()).toBe(machineId());
  });
});

// ---------------------------------------------------------------------------
// resolveProToken
// ---------------------------------------------------------------------------

describe("resolveProToken", () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  it("returns null when neither env nor file is set", () => {
    expect(resolveProToken()).toBeNull();
  });

  it("returns env var when set", () => {
    process.env["ASHLR_PRO_TOKEN"] = "tok-from-env-0000000000000000";
    expect(resolveProToken()).toBe("tok-from-env-0000000000000000");
    delete process.env["ASHLR_PRO_TOKEN"];
  });

  it("returns file token when no env var", () => {
    writeProToken("tok-from-file-0000000000000000");
    expect(resolveProToken()).toBe("tok-from-file-0000000000000000");
  });

  it("prefers env var over file", () => {
    writeProToken("tok-from-file-0000000000000000");
    process.env["ASHLR_PRO_TOKEN"] = "tok-from-env-0000000000000000";
    expect(resolveProToken()).toBe("tok-from-env-0000000000000000");
    delete process.env["ASHLR_PRO_TOKEN"];
  });
});

// ---------------------------------------------------------------------------
// pushStatsToCloud — first sync (no cursor)
// ---------------------------------------------------------------------------

describe("pushStatsToCloud — first sync", () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  it("pushes full payload when cursor is absent", async () => {
    const mock = await startMock();
    writeProToken("tok-cloud-sync-first-0000000000");
    try {
      const result = await pushStatsToCloud({
        apiUrl: mock.url,
        proToken: "tok-cloud-sync-first-0000000000",
      });

      expect(result.skipped).toBe(false);
      expect(result.ok).toBe(true);
      expect(mock.syncCalls.length).toBe(1);

      const payload = mock.syncCalls[0]!.body as {
        apiToken: string;
        stats: { lifetime: { calls: number; tokensSaved: number } };
        machineId: string;
      };
      expect(payload.apiToken).toBe("tok-cloud-sync-first-0000000000");
      expect(typeof payload.stats.lifetime.calls).toBe("number");
      expect(typeof payload.stats.lifetime.tokensSaved).toBe("number");
      expect(payload.machineId).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      mock.stop();
    }
  });

  it("writes cursor on success", async () => {
    const mock = await startMock();
    try {
      await pushStatsToCloud({
        apiUrl: mock.url,
        proToken: "tok-cloud-sync-first-0000000000",
      });
      const cursor = readCursor();
      expect(cursor).not.toBeNull();
      expect(typeof cursor!.syncedAt).toBe("string");
      expect(typeof cursor!.calls).toBe("number");
      expect(typeof cursor!.tokensSaved).toBe("number");
    } finally {
      mock.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// pushStatsToCloud — subsequent sync (cursor present, no delta)
// ---------------------------------------------------------------------------

describe("pushStatsToCloud — subsequent sync", () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  it("skips when cursor matches current stats (no delta)", async () => {
    const mock = await startMock();
    try {
      // First sync to get a cursor
      const r1 = await pushStatsToCloud({
        apiUrl: mock.url,
        proToken: "tok-cloud-sync-delta-0000000000",
      });
      expect(r1.ok).toBe(true);

      // Second sync — cursor matches current stats, nothing changed
      const r2 = await pushStatsToCloud({
        apiUrl: mock.url,
        proToken: "tok-cloud-sync-delta-0000000000",
      });
      expect(r2.skipped).toBe(true);
      expect(r2.reason).toBe("no-delta");
      // Only one HTTP call total
      expect(mock.syncCalls.length).toBe(1);
    } finally {
      mock.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// pushStatsToCloud — network error → cursor unchanged
// ---------------------------------------------------------------------------

describe("pushStatsToCloud — network error handling", () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  it("leaves cursor untouched on HTTP error", async () => {
    const mock = await startMock({ syncStatus: 500 });
    try {
      // Pre-seed a cursor
      writeCursorFixture(5, 1000);
      const before = readCursor();

      const result = await pushStatsToCloud({
        apiUrl: mock.url,
        proToken: "tok-cloud-sync-err-000000000000",
      });

      // Should not throw — error is swallowed
      expect(result.ok).toBe(false);
      expect(result.error ?? result.status).toBeTruthy();

      // Cursor must be unchanged
      const after = readCursor();
      expect(after?.calls).toBe(before?.calls);
      expect(after?.tokensSaved).toBe(before?.tokensSaved);
    } finally {
      mock.stop();
    }
  });

  it("returns error result on unreachable host (no throw)", async () => {
    const result = await pushStatsToCloud({
      apiUrl: "http://127.0.0.1:1", // nothing listening
      proToken: "tok-cloud-sync-err-000000000000",
    });
    expect(result.skipped).toBe(false);
    expect(result.ok).toBeFalsy();
    expect(result.error).toBeTruthy();
  });

  it("skips when no pro-token (free-tier)", async () => {
    const result = await pushStatsToCloud({ apiUrl: "http://127.0.0.1:1" });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no-pro-token");
  });

  it("skips when kill switch ASHLR_STATS_UPLOAD=0", async () => {
    process.env["ASHLR_STATS_UPLOAD"] = "0";
    const result = await pushStatsToCloud({
      apiUrl: "http://127.0.0.1:1",
      proToken: "tok-kill-switch-000000000000000",
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("kill-switch");
    delete process.env["ASHLR_STATS_UPLOAD"];
  });
});

// ---------------------------------------------------------------------------
// maybeCloudSync — free-tier gate
// ---------------------------------------------------------------------------

describe("maybeCloudSync", () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  it("makes no network call when no pro-token (free-tier)", async () => {
    const mock = await startMock();
    try {
      // No token — should be completely silent
      maybeCloudSync();
      await Bun.sleep(150);
      expect(mock.syncCalls.length).toBe(0);
    } finally {
      mock.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// pullAggregateStats — cache TTL
// ---------------------------------------------------------------------------

describe("pullAggregateStats — cache TTL", () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  it("returns from cache when still within TTL", async () => {
    const mock = await startMock();
    try {
      // Seed a fresh cache
      writeAggregateCacheFixture(
        {
          user_id: "u1",
          lifetime_calls: 10,
          lifetime_tokens_saved: 500,
          by_tool: {},
          by_day: {},
          machine_count: 2,
        },
        1000, // 1 second old — well within 1h TTL
      );

      const result = await pullAggregateStats({
        apiUrl: mock.url,
        proToken: "tok-pull-ttl-000000000000000",
      });

      expect(result.fromCache).toBe(true);
      expect(result.data?.lifetime_tokens_saved).toBe(500);
      // No network call
      expect(mock.syncCalls.length).toBe(0);
    } finally {
      mock.stop();
    }
  });

  it("fetches fresh data when cache is expired", async () => {
    const mock = await startMock({
      aggResponse: {
        user_id: "u1",
        lifetime_calls: 200,
        lifetime_tokens_saved: 99_000,
        by_tool: {},
        by_day: {},
        machine_count: 4,
      },
    });
    try {
      // Seed a stale cache (older than CACHE_TTL_MS)
      writeAggregateCacheFixture(
        {
          user_id: "u1",
          lifetime_calls: 10,
          lifetime_tokens_saved: 500,
          by_tool: {},
          by_day: {},
          machine_count: 2,
        },
        CACHE_TTL_MS + 5000, // expired
      );

      const result = await pullAggregateStats({
        apiUrl: mock.url,
        proToken: "tok-pull-ttl-000000000000000",
      });

      expect(result.fromCache).toBe(false);
      expect(result.data?.lifetime_tokens_saved).toBe(99_000);
    } finally {
      mock.stop();
    }
  });

  it("skips when no pro-token (free-tier)", async () => {
    const result = await pullAggregateStats({ apiUrl: "http://127.0.0.1:1" });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no-pro-token");
  });

  it("returns stale cache data on network error", async () => {
    // Seed a stale cache
    writeAggregateCacheFixture(
      {
        user_id: "u1",
        lifetime_calls: 5,
        lifetime_tokens_saved: 250,
        by_tool: {},
        by_day: {},
        machine_count: 2,
      },
      CACHE_TTL_MS + 5000, // expired
    );

    const result = await pullAggregateStats({
      apiUrl: "http://127.0.0.1:1", // unreachable
      proToken: "tok-pull-stale-0000000000000",
    });

    // Should not throw; error is swallowed
    expect(result.skipped).toBe(false);
    expect(result.error).toBeTruthy();
    // Stale cache data is still returned so the dashboard doesn't go blank
    expect(result.data?.lifetime_tokens_saved).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// maybeCloudPull — free-tier gate
// ---------------------------------------------------------------------------

describe("maybeCloudPull", () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  it("makes no network call when no pro-token (free-tier)", async () => {
    const mock = await startMock();
    try {
      maybeCloudPull();
      await Bun.sleep(150);
      expect(mock.syncCalls.length).toBe(0);
    } finally {
      mock.stop();
    }
  });

  it("skips pull when cache is still fresh", async () => {
    writeProToken("tok-pull-fresh-000000000000000");
    // Fresh cache
    writeAggregateCacheFixture(
      {
        user_id: "u1",
        lifetime_calls: 10,
        lifetime_tokens_saved: 500,
        by_tool: {},
        by_day: {},
        machine_count: 2,
      },
      1000, // 1 second old
    );

    const mock = await startMock();
    try {
      maybeCloudPull(); // should no-op due to TTL
      await Bun.sleep(150);
      expect(mock.syncCalls.length).toBe(0); // no calls
    } finally {
      mock.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// isCacheValid
// ---------------------------------------------------------------------------

describe("isCacheValid", () => {
  it("returns false for null", () => {
    expect(isCacheValid(null)).toBe(false);
  });

  it("returns true for a fresh cache", () => {
    expect(
      isCacheValid({
        fetchedAt: new Date().toISOString(),
        data: {
          user_id: "u",
          lifetime_calls: 1,
          lifetime_tokens_saved: 1,
          by_tool: {},
          by_day: {},
        },
      }),
    ).toBe(true);
  });

  it("returns false for an expired cache", () => {
    const old = new Date(Date.now() - CACHE_TTL_MS - 1000).toISOString();
    expect(
      isCacheValid({
        fetchedAt: old,
        data: {
          user_id: "u",
          lifetime_calls: 1,
          lifetime_tokens_saved: 1,
          by_tool: {},
          by_day: {},
        },
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dashboard: renderCrossMachine
// ---------------------------------------------------------------------------

describe("renderCrossMachine", () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  it("returns empty array when no pro-token (free-tier)", () => {
    const lines = renderCrossMachine(tmpHome);
    expect(lines).toHaveLength(0);
  });

  it("returns empty array when pro token present but cache absent", () => {
    writeProToken("tok-dashboard-000000000000000");
    const lines = renderCrossMachine(tmpHome);
    expect(lines).toHaveLength(0);
  });

  it("renders cross-machine section when cache present and pro token exists", () => {
    writeProToken("tok-dashboard-000000000000000");
    writeAggregateCacheFixture({
      user_id: "u1",
      lifetime_calls: 500,
      lifetime_tokens_saved: 250_000,
      by_tool: {},
      by_day: {},
      machine_count: 3,
    });

    const lines = renderCrossMachine(tmpHome);
    expect(lines.length).toBeGreaterThan(0);

    const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("250"); // part of "250.0K"
    expect(plain).toContain("3"); // machine count
  });

  it("renders section without machine_count when backend omits it", () => {
    writeProToken("tok-dashboard-000000000000000");
    writeAggregateCacheFixture({
      user_id: "u1",
      lifetime_calls: 50,
      lifetime_tokens_saved: 10_000,
      by_tool: {},
      by_day: {},
      // machine_count omitted
    });

    const lines = renderCrossMachine(tmpHome);
    expect(lines.length).toBeGreaterThan(0);
    const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("10.0K");
  });
});

// ---------------------------------------------------------------------------
// readAggregateCache — pro-tier gate
// ---------------------------------------------------------------------------

describe("readAggregateCache", () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  it("returns null when no pro-token", () => {
    writeAggregateCacheFixture({
      user_id: "u",
      lifetime_calls: 1,
      lifetime_tokens_saved: 1,
      by_tool: {},
      by_day: {},
    });
    expect(readAggregateCache()).toBeNull();
  });

  it("returns data when pro-token present and cache exists", () => {
    writeProToken("tok-read-cache-000000000000000");
    writeAggregateCacheFixture({
      user_id: "u",
      lifetime_calls: 10,
      lifetime_tokens_saved: 5000,
      by_tool: {},
      by_day: {},
    });
    const data = readAggregateCache();
    expect(data).not.toBeNull();
    expect(data!.lifetime_tokens_saved).toBe(5000);
  });
});
