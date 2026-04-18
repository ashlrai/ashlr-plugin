/**
 * stats-cloud-sync.test.ts
 *
 * Verifies that maybeSyncToCloud() uploads when ASHLR_PRO_TOKEN is set and a
 * real server is reachable, and stays silent (no network call) when the token
 * is absent or the kill switch is active.
 *
 * Uses a tiny Bun.serve() mock so no external network is needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { maybeSyncToCloud, _resetMemCache, _resetCloudSync } from "../servers/_stats.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockServer {
  url: string;
  calls: Array<{ body: unknown }>;
  stop: () => void;
}

async function startMock(): Promise<MockServer> {
  const calls: Array<{ body: unknown }> = [];

  const server = Bun.serve({
    port: 0, // OS-assigned free port
    async fetch(req) {
      if (req.method === "POST" && new URL(req.url).pathname === "/stats/sync") {
        const body = await req.json().catch(() => null);
        calls.push({ body });
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    calls,
    stop: () => server.stop(),
  };
}

/** Wait up to maxMs for predicate to become true (polls every 20ms). */
async function waitFor(predicate: () => boolean, maxMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > maxMs) throw new Error("waitFor timed out");
    await Bun.sleep(20);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("maybeSyncToCloud", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetMemCache();
    _resetCloudSync();
    // Reset env
    delete process.env["ASHLR_PRO_TOKEN"];
    delete process.env["ASHLR_API_URL"];
    delete process.env["ASHLR_STATS_UPLOAD"];
  });

  afterEach(() => {
    // Restore env
    for (const key of ["ASHLR_PRO_TOKEN", "ASHLR_API_URL", "ASHLR_STATS_UPLOAD"]) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
    _resetMemCache();
  });

  it("uploads to the mock server when ASHLR_PRO_TOKEN is set", async () => {
    const mock = await startMock();
    try {
      process.env["ASHLR_PRO_TOKEN"] = "test-token-cloud-sync-0000000000000";
      process.env["ASHLR_API_URL"]   = mock.url;

      maybeSyncToCloud();

      await waitFor(() => mock.calls.length > 0);

      expect(mock.calls.length).toBe(1);
      const call = mock.calls[0]!;
      // Payload must have the right shape
      expect(call.body).toMatchObject({
        apiToken: "test-token-cloud-sync-0000000000000",
        stats: { lifetime: { calls: expect.any(Number), tokensSaved: expect.any(Number) } },
      });
    } finally {
      mock.stop();
    }
  });

  it("makes no network call when ASHLR_PRO_TOKEN is absent", async () => {
    const mock = await startMock();
    try {
      process.env["ASHLR_API_URL"] = mock.url;
      // No ASHLR_PRO_TOKEN set

      maybeSyncToCloud();

      // Give async code a chance to run if it incorrectly fires
      await Bun.sleep(100);
      expect(mock.calls.length).toBe(0);
    } finally {
      mock.stop();
    }
  });

  it("makes no network call when ASHLR_STATS_UPLOAD=0 kill switch is active", async () => {
    const mock = await startMock();
    try {
      process.env["ASHLR_PRO_TOKEN"]    = "test-token-cloud-sync-0000000000000";
      process.env["ASHLR_API_URL"]      = mock.url;
      process.env["ASHLR_STATS_UPLOAD"] = "0";

      maybeSyncToCloud();

      await Bun.sleep(100);
      expect(mock.calls.length).toBe(0);
    } finally {
      mock.stop();
    }
  });

  it("does not upload twice within the 5-minute window", async () => {
    const mock = await startMock();
    try {
      process.env["ASHLR_PRO_TOKEN"] = "test-token-cloud-sync-0000000000000";
      process.env["ASHLR_API_URL"]   = mock.url;

      maybeSyncToCloud();
      await waitFor(() => mock.calls.length > 0);

      // Second call immediately — should be throttled
      maybeSyncToCloud();
      await Bun.sleep(100);

      expect(mock.calls.length).toBe(1);
    } finally {
      mock.stop();
    }
  });
});
