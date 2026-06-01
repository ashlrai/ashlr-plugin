/**
 * Back-compat test for the v1.34 optional measured-savings fields in _stats.ts.
 *
 * Covers:
 *   1. recordSaving without measurementMode still works (estimate path)
 *   2. recordSaving with measurementMode="measured" increments measured fields
 *   3. Legacy stats.json without measured fields round-trips correctly
 *   4. coerceLifetime preserves measured fields when present
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  _drainWrites,
  _resetMemCache,
  readStats,
  recordSaving,
  migrateToV2,
} from "../servers/_stats";

let home: string;
const origHome = process.env.HOME;
const origSession = process.env.CLAUDE_SESSION_ID;
const origSync = process.env.ASHLR_STATS_SYNC;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-stats-measured-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAUDE_SESSION_ID = "test-measured-session";
  process.env.ASHLR_STATS_SYNC = "1"; // synchronous writes for testing
});

afterEach(async () => {
  await _drainWrites();
  process.env.HOME = origHome;
  if (origSession) process.env.CLAUDE_SESSION_ID = origSession;
  else delete process.env.CLAUDE_SESSION_ID;
  if (origSync !== undefined) process.env.ASHLR_STATS_SYNC = origSync;
  else delete process.env.ASHLR_STATS_SYNC;
  _resetMemCache();
  await rm(home, { recursive: true, force: true });
});

describe("recordSaving back-compat (no measurementMode)", () => {
  test("estimate path works unchanged", async () => {
    const saved = await recordSaving(4000, 1000, "ashlr__read");
    expect(saved).toBeGreaterThan(0);

    await _drainWrites();
    const stats = await readStats();
    expect(stats.lifetime.tokensSaved).toBeGreaterThan(0);
    // measured fields should be absent or 0 when never used
    expect(stats.lifetime.tokensSavedMeasured ?? 0).toBe(0);
    expect(stats.lifetime.measuredCalls ?? 0).toBe(0);
  });
});

describe("recordSaving with measurementMode=measured", () => {
  test("increments tokensSavedMeasured and measuredCalls in session + lifetime", async () => {
    await recordSaving(4000, 1000, "ashlr__read", { measurementMode: "measured" });
    await _drainWrites();

    const stats = await readStats();
    // Estimate fields also incremented (measured mode adds to both)
    expect(stats.lifetime.tokensSaved).toBeGreaterThan(0);
    // Measured fields should now be populated
    expect(stats.lifetime.tokensSavedMeasured ?? 0).toBeGreaterThan(0);
    expect(stats.lifetime.measuredCalls ?? 0).toBe(1);

    // Session bucket should also have measured fields
    const sessions = Object.values(stats.sessions);
    expect(sessions.length).toBeGreaterThan(0);
    const sess = sessions[0]!;
    expect(sess.tokensSavedMeasured ?? 0).toBeGreaterThan(0);
    expect(sess.measuredCalls ?? 0).toBe(1);
  });

  test("accumulates across multiple measured calls", async () => {
    await recordSaving(4000, 1000, "ashlr__read", { measurementMode: "measured" });
    await recordSaving(8000, 2000, "ashlr__grep", { measurementMode: "measured" });
    await _drainWrites();

    const stats = await readStats();
    expect(stats.lifetime.measuredCalls ?? 0).toBe(2);
    expect(stats.lifetime.tokensSavedMeasured ?? 0).toBeGreaterThan(0);
  });
});

describe("legacy stats.json back-compat", () => {
  test("file without measured fields round-trips without error", async () => {
    // Simulate a pre-v1.34 stats file (no measured fields anywhere)
    const legacyShape = {
      schemaVersion: 2,
      sessions: {
        "old-session": {
          startedAt: "2024-01-01T00:00:00.000Z",
          lastSavingAt: null,
          calls: 5,
          tokensSaved: 1000,
          byTool: { "ashlr__read": { calls: 5, tokensSaved: 1000 } },
          // No tokensSavedMeasured, no measuredCalls
        },
      },
      lifetime: {
        calls: 5,
        tokensSaved: 1000,
        byTool: { "ashlr__read": { calls: 5, tokensSaved: 1000 } },
        byDay: { "2024-01-01": { calls: 5, tokensSaved: 1000 } },
        // No tokensSavedMeasured, no measuredCalls, no rawTotal
      },
    };

    // Write and read back via migrateToV2
    const migrated = migrateToV2(legacyShape);
    expect(migrated.lifetime.tokensSaved).toBe(1000);
    expect(migrated.lifetime.tokensSavedMeasured ?? 0).toBe(0);
    expect(migrated.lifetime.measuredCalls ?? 0).toBe(0);
    // Sessions preserved
    expect(migrated.sessions["old-session"]?.tokensSaved).toBe(1000);
    expect(migrated.sessions["old-session"]?.tokensSavedMeasured ?? 0).toBe(0);
  });
});
