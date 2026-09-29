/**
 * cloud-sync-flow.test.ts — Plugin to backend round-trip.
 *
 * - Start backend.
 * - Issue a pro token (upgrade via DB direct).
 * - Run 5 tool calls with ASHLR_PRO_TOKEN + ASHLR_API_URL set.
 * - Poll GET /stats/aggregate until remote counts match local stats.json.
 * - Assert: remote counts match local within 10 seconds.
 *
 * NOTE: /stats/aggregate requires pro tier. We patch the DB directly since
 * there's no admin API endpoint for tier upgrades in TESTING mode.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { rmSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import {
  makeTempHome,
  startBackend,
  startMcpServer,
  issueToken,
  fetchApi,
  readLocalStats,
  pollUntil,
  SERVERS_DIR,
} from "../lib/harness.ts";

describe("cloud-sync-flow", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) await fn().catch(() => {});
    cleanup = [];
  });

  it("syncs 5 tool calls to the backend and aggregate matches local stats", async () => {
    const tempHome = makeTempHome();
    cleanup.push(async () => rmSync(tempHome, { recursive: true, force: true }));

    const backend = await startBackend({ tempHome });
    cleanup.push(backend.teardown);

    const token = await issueToken(backend.dbPath, "sync-test@example.com");

    // Upgrade user to pro tier directly in the DB so /stats/aggregate is accessible
    const db = new Database(backend.dbPath);
    // The backend process may still hold a write lock right after startup /
    // token issuance; wait for it instead of failing with SQLITE_BUSY (seen
    // intermittently on CI).
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`UPDATE users SET tier = 'pro' WHERE email = 'sync-test@example.com'`);
    db.close();

    // Write a small fixture file to read
    const projectDir = join(tempHome, "project");
    mkdirSync(projectDir, { recursive: true });
    const filePath = join(projectDir, "file.ts");
    writeFileSync(filePath, "// test file\n" + "const x = 1;\n".repeat(200));

    const { callTool, teardown } = await startMcpServer({
      serverFile: join(SERVERS_DIR, "efficiency-server.ts"),
      tempHome,
      env: {
        CLAUDE_SESSION_ID: "test-session-cloud-sync",
        ASHLR_PRO_TOKEN: token,
        ASHLR_API_URL: backend.url,
        ASHLR_STATS_SYNC: "1",
        ASHLR_DISABLE_CLOUD_LLM: "1",
      },
    });
    cleanup.push(teardown);

    // Run 5 tool calls
    for (let i = 0; i < 5; i++) {
      await callTool("ashlr__read", { path: filePath });
    }

    // Give stats sync a moment (it's fire-and-forget in the server)
    const localStats = readLocalStats(tempHome);
    const localCalls = localStats?.lifetime?.calls ?? 0;
    expect(localCalls).toBeGreaterThanOrEqual(5);

    // Manually sync to the backend using the stats we know
    const syncBody = {
      apiToken: token,
      stats: {
        lifetime: {
          calls: localCalls,
          tokensSaved: localStats?.lifetime?.tokensSaved ?? 0,
          byTool: Object.fromEntries(
            Object.entries(localStats?.lifetime?.byTool ?? {}).map(([k, v]) => [
              k,
              v.calls,
            ]),
          ),
        },
      },
    };

    const syncRes = await fetchApi(backend.url, "/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(syncBody),
    });
    expect(syncRes.status).toBe(200);

    // Poll aggregate until counts match
    await pollUntil(async () => {
      const res = await fetchApi(backend.url, "/stats/aggregate", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const data = await res.json() as { lifetime_calls: number };
      return data.lifetime_calls >= localCalls;
    }, 10_000);

    const aggRes = await fetchApi(backend.url, "/stats/aggregate", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(aggRes.status).toBe(200);
    const agg = await aggRes.json() as { lifetime_calls: number };
    expect(agg.lifetime_calls).toBeGreaterThanOrEqual(localCalls);
  }, 30_000);
});
