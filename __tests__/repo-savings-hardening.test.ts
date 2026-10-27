import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { isoWeek, missStatsPath } from "../servers/_miss-tracker";
import { LOCK_STALE_MS, readRepoSavings, recordRepoSaving, repoSavingsPath, withLock } from "../servers/_repo-savings";
import { renderTuningSection } from "../servers/_tuning-render";

const A = "/repo-a";
const NOW = Date.parse("2026-10-25T12:00:00Z"); // 2026-W43 (UTC)
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-repo-sav-h-"));
  delete process.env.ASHLR_TUNING;
  delete process.env.ASHLR_SESSION_LOG;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("repo savings write safety", () => {
  test("leaves no lock or temp files behind", () => {
    recordRepoSaving(10, home, A, NOW);
    const dir = dirname(repoSavingsPath(home, A));
    expect(readdirSync(dir).filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"))).toEqual([]);
    expect(readRepoSavings(home, A).weeks).toEqual({ "2026-W43": 10 });
  });

  test("a write that starts while another holds the lock re-reads and merges", () => {
    const p = repoSavingsPath(home, A);
    recordRepoSaving(5, home, A, NOW);
    // Simulate another writer: inside its lock it adds 7 on disk.
    withLock(`${p}.lock`, () => {
      writeFileSync(p, JSON.stringify({ weeks: { "2026-W43": 12 } }));
    });
    recordRepoSaving(3, home, A, NOW);
    expect(readRepoSavings(home, A).weeks).toEqual({ "2026-W43": 15 });
  });

  test("a stale lock from a crashed writer is removed", () => {
    const p = repoSavingsPath(home, A);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.lock`, "");
    const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
    utimesSync(`${p}.lock`, old, old);
    recordRepoSaving(4, home, A, NOW);
    expect(readRepoSavings(home, A).weeks).toEqual({ "2026-W43": 4 });
    expect(existsSync(`${p}.lock`)).toBe(false);
  });

  test("a held fresh lock times out and the write still lands atomically", () => {
    const p = repoSavingsPath(home, A);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.lock`, "");
    recordRepoSaving(6, home, A, NOW);
    expect(readRepoSavings(home, A).weeks).toEqual({ "2026-W43": 6 });
    expect(existsSync(`${p}.lock`)).toBe(true); // not ours, not removed
  });
});

describe("net display", () => {
  test("re-reads with zero recorded savings show n/a, not a negative net", () => {
    mkdirSync(dirname(missStatsPath(home, A)), { recursive: true });
    writeFileSync(missStatsPath(home, A), JSON.stringify({ tools: {}, weeks: { [isoWeek(NOW)]: { compressed: 10, misses: 1, refetchBytes: 400 } } }));
    const row = renderTuningSection(home, A, NOW)!.split("\n").find((l) => l.includes("2026-W43"))!;
    expect(row).toMatch(/\s0\s+100\s+n\/a\s+10\.0%/);
    expect(row).not.toContain("-100");
  });

  test("recorded savings smaller than re-read cost still show the negative net", () => {
    recordRepoSaving(50, home, A, NOW);
    mkdirSync(dirname(missStatsPath(home, A)), { recursive: true });
    writeFileSync(missStatsPath(home, A), JSON.stringify({ tools: {}, weeks: { [isoWeek(NOW)]: { compressed: 10, misses: 1, refetchBytes: 400 } } }));
    const row = renderTuningSection(home, A, NOW)!.split("\n").find((l) => l.includes("2026-W43"))!;
    expect(row).toMatch(/50\s+100\s+-50\s/);
  });
});
