/**
 * stats-sqlite-concurrent.test.ts — the whole point of migrating off JSON.
 *
 * The legacy _stats.ts path serialized writes via an in-process mutex + a
 * filesystem lockfile. The combination still produced 6 distinct regressions
 * across v0.9.x → v1.0.x when multiple MCP server processes raced. SQLite in
 * WAL mode hands that problem to the database.
 *
 * This test spawns N child bun processes that each call recordSaving M times
 * in parallel against the same db file. After every child exits we assert
 * that the lifetime counters match exactly N × M × savedPerCall — i.e. no
 * lost updates, no double-counts, no truncated writes.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  _resetConnection,
  _setDbPathForTests,
  initSessionBucket,
  readStats,
} from "../servers/_stats-sqlite";

const CHILD = resolve(import.meta.dir, "fixtures", "concurrent-stats-writer.ts");

let SANDBOX: string;
let DB_PATH: string;

beforeEach(async () => {
  SANDBOX = mkdtempSync(join(tmpdir(), "ashlr-stats-concurrent-"));
  DB_PATH = join(SANDBOX, "stats.db");
  _setDbPathForTests(DB_PATH);
  // Production SessionStart hook runs migrate-stats-to-sqlite.ts once before
  // any MCP worker spawns, so the schema + seed rows exist before the write
  // contention starts. Mirror that here so the test reflects prod behavior.
  // Without this, N children all race on first-time DDL and one occasionally
  // loses a write to the cold-open window.
  await initSessionBucket("warmup");
  _resetConnection();
});

afterEach(() => {
  _resetConnection();
  _setDbPathForTests(null);
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ok */ }
});

function spawnWriter(
  sessionId: string,
  iterations: number,
  savedPerCall: number,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "bun",
      ["run", CHILD, DB_PATH, sessionId, String(iterations), String(savedPerCall)],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`writer exit ${code}: ${stderr}`));
    });
  });
}

describe("servers/_stats-sqlite.ts under cross-process writes", () => {
  it("no lost updates — 4 parallel writers × 50 iters each land all 200 writes", async () => {
    const WRITERS = 4;
    const ITERS = 50;
    const SAVED_PER_CALL = 100;
    const EXPECTED = WRITERS * ITERS * SAVED_PER_CALL;

    await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        spawnWriter(`s${i}`, ITERS, SAVED_PER_CALL),
      ),
    );

    // Child procs wrote under ASHLR_STATS_DB_PATH=DB_PATH. Re-open the db
    // here (parent process has a separate connection — WAL makes it see
    // all committed children's writes as-of now).
    _resetConnection();

    const stats = await readStats();
    expect(stats.lifetime.calls).toBe(WRITERS * ITERS);
    expect(stats.lifetime.tokensSaved).toBe(EXPECTED);
    expect(stats.lifetime.byTool["ashlr__read"]?.calls).toBe(WRITERS * ITERS);
    // +1 for the "warmup" session the test beforeEach seeded.
    expect(Object.keys(stats.sessions).length).toBe(WRITERS + 1);
    for (let i = 0; i < WRITERS; i++) {
      const s = stats.sessions[`s${i}`];
      expect(s).toBeDefined();
      expect(s!.calls).toBe(ITERS);
      expect(s!.tokensSaved).toBe(ITERS * SAVED_PER_CALL);
    }
  }, 60_000);

  it("contention on the same (session, tool) pair does not lose updates", async () => {
    // Two writers hammering the SAME session id — the tightest contention
    // point, where the legacy JSON path historically dropped writes.
    const WRITERS = 2;
    const ITERS = 40;
    const SAVED_PER_CALL = 75;

    await Promise.all(
      Array.from({ length: WRITERS }, () =>
        spawnWriter("shared-session", ITERS, SAVED_PER_CALL),
      ),
    );

    _resetConnection();

    const stats = await readStats();
    expect(stats.lifetime.calls).toBe(WRITERS * ITERS);
    const sessionBucket = stats.sessions["shared-session"]!;
    expect(sessionBucket.calls).toBe(WRITERS * ITERS);
    expect(sessionBucket.tokensSaved).toBe(WRITERS * ITERS * SAVED_PER_CALL);
    expect(sessionBucket.byTool["ashlr__read"]?.calls).toBe(WRITERS * ITERS);
  }, 60_000);
});
