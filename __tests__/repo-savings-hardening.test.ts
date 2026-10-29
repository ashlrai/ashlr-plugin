import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { timingBudgetMs } from "../scripts/timing-budget";
import { isoWeek, missStatsPath } from "../servers/_miss-tracker";
import { LOCK_STALE_MS, readRepoSavings, recordRepoSaving, repoSavingsPath, withLock } from "../servers/_repo-savings";
import { renderTuningSection } from "../servers/_tuning-render";

const A = "/repo-a";
const NOW = Date.parse("2026-10-25T12:00:00Z"); // 2026-W43 (UTC)
let home: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-repo-sav-h-"));
  savedEnv = { ASHLR_TUNING: process.env.ASHLR_TUNING, ASHLR_SESSION_LOG: process.env.ASHLR_SESSION_LOG };
  delete process.env.ASHLR_TUNING;
  delete process.env.ASHLR_SESSION_LOG;
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const savingsModule = fileURLToPath(new URL("../servers/_repo-savings.ts", import.meta.url));

function worker(body: string) {
  const child = Bun.spawn([process.execPath, "-e", `
    import { recordRepoSaving, withLock } from ${JSON.stringify(savingsModule)};
    ${body}
  `], { env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "pipe" });
  // Lock regressions must fail a test, rather than wedge the whole test worker.
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timingBudgetMs(4_000));
  const result = Promise.all([child.exited, new Response(child.stderr).text()])
    .then(([exitCode, stderr]) => ({ exitCode, stderr, timedOut }))
    .finally(() => clearTimeout(timer));
  return { child, result };
}

describe("repo savings write safety", () => {
  test("leaves no lock or temp files behind", () => {
    recordRepoSaving(10, home, A, NOW);
    const dir = dirname(repoSavingsPath(home, A));
    expect(readdirSync(dir).filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"))).toEqual([]);
    expect(readRepoSavings(home, A).weeks).toEqual({ "2026-W43": 10 });
  });

  test("a failed atomic rename cleans up and later accounting recovers", () => {
    const p = repoSavingsPath(home, A);
    // A directory at the destination makes rename fail on every platform.
    mkdirSync(p, { recursive: true });
    expect(() => recordRepoSaving(10, home, A, NOW)).not.toThrow();
    expect(readdirSync(dirname(p)).filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"))).toEqual([]);
    rmSync(p, { recursive: true });
    recordRepoSaving(3, home, A, NOW);
    expect(readRepoSavings(home, A).weeks).toEqual({ "2026-W43": 3 });
    expect(readdirSync(dirname(p)).filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"))).toEqual([]);
  });

  test("a throwing callback releases its lock", () => {
    const lock = `${repoSavingsPath(home, A)}.lock`;
    expect(() => withLock(lock, () => { throw new Error("callback failed"); })).toThrow("callback failed");
    expect(existsSync(lock)).toBe(false);
    recordRepoSaving(4, home, A, NOW);
    expect(readRepoSavings(home, A).weeks).toEqual({ "2026-W43": 4 });
  });

  test("a non-contention lock error still runs accounting without hanging", async () => {
    // An overlong filename fails open with ENAMETOOLONG (or another path error),
    // without relying on user permissions or mocking the filesystem.
    const invalidLock = join(home, "x".repeat(300));
    const { result } = worker(`withLock(${JSON.stringify(invalidLock)}, () => recordRepoSaving(7, ${JSON.stringify(home)}, ${JSON.stringify(A)}, ${NOW}));`);
    expect(await result).toEqual({ exitCode: 0, stderr: "", timedOut: false });
    expect(readRepoSavings(home, A).weeks).toEqual({ "2026-W43": 7 });
  }, timingBudgetMs(8_000));

  test("each write re-reads and merges the previous writer's savings", () => {
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

  test("a dangling lock symlink cannot make accounting hang", async () => {
    const p = repoSavingsPath(home, A);
    mkdirSync(dirname(p), { recursive: true });
    const missing = join(home, "missing-lock-target");
    // A junction exercises the same EEXIST/ENOENT pair without requiring
    // Windows' optional permission to create file symlinks.
    symlinkSync(missing, `${p}.lock`, process.platform === "win32" ? "junction" : "file");
    const originalTarget = readlinkSync(`${p}.lock`);
    const { result } = worker(`recordRepoSaving(9, ${JSON.stringify(home)}, ${JSON.stringify(A)}, ${NOW});`);
    expect(await result).toEqual({ exitCode: 0, stderr: "", timedOut: false });
    expect(readRepoSavings(home, A).weeks).toEqual({ "2026-W43": 9 });
    expect(readlinkSync(`${p}.lock`)).toBe(originalTarget);
    expect(readdirSync(dirname(p)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, timingBudgetMs(8_000));

  test("separate writers re-read and preserve every prior increment without contention", async () => {
    recordRepoSaving(1, home, A, NOW);
    // Serialize processes so each acquires the normal lock, rather than the
    // documented best-effort timeout fallback that can lose concurrent deltas.
    for (const total of [37, 73]) {
      const { result } = worker(`
        for (let n = 0; n < 18; n++) recordRepoSaving(2, ${JSON.stringify(home)}, ${JSON.stringify(A)}, ${NOW});
      `);
      expect(await result).toEqual({ exitCode: 0, stderr: "", timedOut: false });
      expect(readRepoSavings(home, A).weeks).toEqual({ "2026-W43": total });
    }
  }, timingBudgetMs(8_000));

  test("contending processes preserve complete atomic JSON during best-effort accounting", async () => {
    const p = repoSavingsPath(home, A);
    recordRepoSaving(1, home, A, NOW);
    writeFileSync(`${p}.lock`, "");
    const start = join(home, "start");
    const writers = Array.from({ length: 3 }, (_, i) => worker(`
      import { existsSync, writeFileSync } from "fs";
      writeFileSync(${JSON.stringify(join(home, `ready-${i}`))}, "");
      while (!existsSync(${JSON.stringify(start)})) await Bun.sleep(1);
      for (let n = 0; n < 12; n++) {
        recordRepoSaving(2, ${JSON.stringify(home)}, ${JSON.stringify(A)}, ${NOW});
        await Bun.sleep(1);
      }
    `));
    try {
      const deadline = performance.now() + timingBudgetMs(2_000);
      while (!writers.every((_, i) => existsSync(join(home, `ready-${i}`))) && performance.now() < deadline) await Bun.sleep(5);
      expect(writers.every((_, i) => existsSync(join(home, `ready-${i}`)))).toBe(true);
      writeFileSync(start, "");
      // All workers start with an occupied lock, then compete to acquire it.
      await Bun.sleep(25);
      unlinkSync(`${p}.lock`);
      let finished = false;
      const completion = Promise.all(writers.map((w) => w.result)).then((results) => { finished = true; return results; });
      let reads = 0;
      while (!finished) {
        const value = JSON.parse(readFileSync(p, "utf-8")).weeks["2026-W43"];
        expect(Number.isInteger(value) && value >= 1 && value <= 73 && value % 2 === 1).toBe(true);
        reads++;
        await Bun.sleep(1);
      }
      expect(await completion).toEqual(writers.map(() => ({ exitCode: 0, stderr: "", timedOut: false })));
      expect(reads).toBeGreaterThan(0);
      const weeks = readRepoSavings(home, A).weeks;
      expect(Object.keys(weeks)).toEqual(["2026-W43"]);
      const total = weeks["2026-W43"];
      // Under long contention the 250 ms timeout allows an unlocked atomic
      // write. Deltas may be lost, but JSON and counter validity must survive.
      expect(Number.isInteger(total) && total >= 3 && total <= 73 && total % 2 === 1).toBe(true);
      expect(readdirSync(dirname(p)).filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"))).toEqual([]);
      if (process.platform !== "win32") {
        expect(statSync(p).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(p)).mode & 0o777).toBe(0o700);
      }
    } finally {
      for (const { child } of writers) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.all(writers.map((w) => w.result));
    }
  }, timingBudgetMs(8_000));
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
