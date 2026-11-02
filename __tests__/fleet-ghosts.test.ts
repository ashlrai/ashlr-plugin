import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetGhosts } from "../scripts/fleet-ghosts.ts";

let runs: string;
const NOW = Date.parse("2026-10-30T12:00:00Z");
const lane = (name: string) => { const dir = join(runs, name); mkdirSync(dir, { recursive: true }); return dir; };
const base = (dir: string, job: string) => mkdirSync(join(dir, `${job}.base`), { recursive: true });
const touch = (dir: string, name: string) => writeFileSync(join(dir, name), "x\n");
const procs = (...lines: string[]) => () => lines;
const deps = (lines: string[], extra: { alive?: (pid: number) => boolean } = {}) =>
  ({ procs: procs(...lines), now: () => NOW, ...extra });
const laneOf = (report: ReturnType<typeof fleetGhosts>, name: string) => report.lanes.find(l => l.lane === name);

beforeEach(() => { runs = realpathSync(mkdtempSync(join(tmpdir(), "ghosts-"))); });
afterEach(() => rmSync(runs, { recursive: true, force: true }));

test("one live job and one gzipped dead job reports exactly one ghost", () => {
  const dir = lane("fake-lane");
  base(dir, "job-live"); touch(dir, "job-live.log");
  base(dir, "job-dead"); touch(dir, "job-dead.log.gz");
  const report = fleetGhosts(runs, deps([`bun run ${join(dir, "job-live.base")}/serve.ts`]));
  expect(laneOf(report, "fake-lane")).toMatchObject({ reported: 1, live: 1, live_unknown: 0, stalled: [], ghosts: ["job-dead"] });
  expect(report.counts).toMatchObject({ lanes: 1, reported: 1, live: 1, stalled: 0, ghosts: 1 });
  expect(report.live_known).toBe(true);
  expect(report.errors).toEqual({});
});

test("reported jobs with no live process are stalled, not ghosts", () => {
  const dir = lane("fake-lane");
  base(dir, "job-stall"); touch(dir, "job-stall.log");
  base(dir, "job-gzip"); touch(dir, "job-gzip.log"); touch(dir, "job-gzip.log.gz");
  const report = fleetGhosts(runs, deps([]));
  expect(laneOf(report, "fake-lane")).toMatchObject({ reported: 2, live: 0, stalled: ["job-gzip", "job-stall"], ghosts: [] });
  expect(report.counts).toMatchObject({ reported: 2, live: 0, stalled: 2, ghosts: 0 });
});

test("a live pid file counts a job live without a command-line match", () => {
  const dir = lane("fake-lane");
  base(dir, "job-pid"); touch(dir, "job-pid.log"); writeFileSync(join(dir, "job-pid.pid"), "4321\n");
  base(dir, "job-dead"); touch(dir, "job-dead.log"); writeFileSync(join(dir, "job-dead.pid"), "9876\n");
  const report = fleetGhosts(runs, deps([], { alive: pid => pid === 4321 }));
  expect(laneOf(report, "fake-lane")).toMatchObject({ reported: 2, live: 1, stalled: ["job-dead"], ghosts: [] });
});

test("ghost rules are exact: base without .log.gz, and .log.gz without .base, are not ghosts", () => {
  const dir = lane("fake-lane");
  base(dir, "job-bare");                                   // worktree only, never ran
  touch(dir, "job-nolog"); touch(dir, "job-nolog.log.gz"); // archived log, worktree already gone
  const report = fleetGhosts(runs, deps([]));
  expect(laneOf(report, "fake-lane")).toMatchObject({ reported: 0, live: 0, stalled: [], ghosts: [] });
  expect(report.counts.ghosts).toBe(0);
});

test("a dead-pid or unmatched command line does not resurrect a ghost", () => {
  const dir = lane("fake-lane");
  base(dir, "job-dead"); touch(dir, "job-dead.log.gz"); writeFileSync(join(dir, "job-dead.pid"), "9876\n");
  const report = fleetGhosts(runs, deps(["sleep 60 /tmp/other"], { alive: pid => pid === 4321 }));
  expect(laneOf(report, "fake-lane")!.ghosts).toEqual(["job-dead"]);
});

test("command-line matching is boundary-safe", () => {
  const dir = lane("fake-lane");
  base(dir, "job-live"); touch(dir, "job-live.log");
  const named = (args: string) => fleetGhosts(runs, deps([args]));
  // Suffixes and prefixes that only contain job-live as a substring do not count.
  expect(laneOf(named(`bun ${join(dir, "xjob-live.base")}`), "fake-lane")!.live).toBe(0);
  expect(laneOf(named(`bun ${join(dir, "job-live.bases")}`), "fake-lane")!.live).toBe(0);
  expect(laneOf(named(`bun ${join(dir, "job-live.base")} --flag`), "fake-lane")!.live).toBe(1);
  expect(laneOf(named(`bun ${join(dir, "job-live.base")}/deep/file.ts`), "fake-lane")!.live).toBe(1);
});

test("job files at the runs root report under the . lane", () => {
  const dir = lane("fake-lane");
  base(dir, "job-lane"); touch(dir, "job-lane.log");
  base(runs, "job-root"); touch(runs, "job-root.log.gz");
  const report = fleetGhosts(runs, deps([`x ${join(dir, "job-lane.base")}`]));
  expect(laneOf(report, ".")).toMatchObject({ reported: 0, ghosts: ["job-root"] });
  expect(laneOf(report, "fake-lane")).toMatchObject({ reported: 1, live: 1, ghosts: [] });
  expect(report.lanes.map(l => l.lane)).toEqual([".", "fake-lane"]);
});

test("dot directories at the runs root are not lanes", () => {
  const dir = lane("fake-lane");
  base(dir, "job-live"); touch(dir, "job-live.log");
  // The CLI tests below keep HOME inside runs, where bun/macOS may drop
  // .bun/Library; debris like that must never surface as a lane, even when
  // its contents look like a ghost job.
  const hidden = join(runs, ".bun"); mkdirSync(hidden, { recursive: true });
  base(hidden, "job-hidden"); touch(hidden, "job-hidden.log.gz");
  const report = fleetGhosts(runs, deps([`x ${join(dir, "job-live.base")}`]));
  expect(report.lanes.map(l => l.lane)).toEqual(["fake-lane"]);
  expect(report.counts).toMatchObject({ lanes: 1, ghosts: 0 });
});

test("directories without immediate job artifacts are not lanes", () => {
  lane("empty-lane");
  const cache = join(lane("Library"), "Caches");
  mkdirSync(cache);
  base(cache, "nested-job"); touch(cache, "nested-job.log.gz");
  touch(lane("Documents"), "notes.txt");
  const report = fleetGhosts(runs, deps([]));
  expect(report).toMatchObject({ lanes: [], counts: { lanes: 0, ghosts: 0 } });
});

test("job artifacts identify lanes regardless of the directory name", () => {
  const dir = lane("Library");
  base(dir, "job-dead"); touch(dir, "job-dead.log.gz");
  const report = fleetGhosts(runs, deps([]));
  expect(report.lanes).toEqual([
    { lane: "Library", reported: 0, live: 0, live_unknown: 0, stalled: [], ghosts: ["job-dead"] },
  ]);
  expect(report.counts).toMatchObject({ lanes: 1, ghosts: 1 });
});

test("an unreadable process table degrades liveness without inventing ghosts", () => {
  const dir = lane("fake-lane");
  base(dir, "job-live"); touch(dir, "job-live.log"); writeFileSync(join(dir, "job-live.pid"), "4321\n");
  base(dir, "job-dead"); touch(dir, "job-dead.log.gz");
  const report = fleetGhosts(runs, { procs: () => { throw new Error("ps failed"); }, alive: pid => pid === 4321, now: () => NOW });
  const l = laneOf(report, "fake-lane")!;
  expect(report.live_known).toBe(false);
  expect(report.errors.processes).toBe("unavailable");
  expect(l).toMatchObject({ reported: 1, live: 1, live_unknown: 0, stalled: [], ghosts: [] });
});

test("empty runs directory yields an empty report", () => {
  const report = fleetGhosts(runs, deps([]));
  expect(report).toMatchObject({ schema_version: 1, live_known: true, lanes: [], errors: {},
    counts: { lanes: 0, reported: 0, live: 0, live_unknown: 0, stalled: 0, ghosts: 0 } });
  expect(() => fleetGhosts(join(runs, "nope"), deps([]))).toThrow();
});

test.skipIf(process.platform === "win32")("CLI reports a real live process and a ghost end to end", async () => {
  const dir = lane("fake-lane");
  base(dir, "job-live"); touch(dir, "job-live.log");
  base(dir, "job-dead"); touch(dir, "job-dead.log.gz");
  const sleeper = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30_000)", join(dir, "job-live.base")]);
  try {
    // HOME lives in a dot dir inside runs: bun/macOS may drop .bun/Library
    // there, and dot directories can never become lanes.
    const env = { HOME: join(runs, ".home"), PATH: "/usr/bin:/bin" };
    mkdirSync(env.HOME, { recursive: true });
    const run = Bun.spawnSync([process.execPath, "scripts/fleet-ghosts.ts", runs], {
      cwd: join(import.meta.dir, ".."), env,
    });
    expect(run.exitCode).toBe(0);
    const report = JSON.parse(run.stdout.toString());
    expect(report.lanes[0]).toMatchObject({ lane: "fake-lane", reported: 1, live: 1, stalled: [], ghosts: ["job-dead"] });
    expect(report.counts).toMatchObject({ reported: 1, live: 1, ghosts: 1 });
  } finally {
    sleeper.kill();
    await sleeper.exited;
  }
}, 20_000);

test("CLI rejects bad arguments and a missing runs directory", () => {
  const env = { HOME: join(runs, ".home"), PATH: "/usr/bin:/bin" };
  mkdirSync(env.HOME, { recursive: true });
  const run = (args: string[]) => Bun.spawnSync([process.execPath, "scripts/fleet-ghosts.ts", ...args], {
    cwd: join(import.meta.dir, ".."), env,
  });
  expect(run([]).exitCode).toBe(1);
  expect(run(["a", "b"]).exitCode).toBe(1);
  expect(run([join(runs, "nope")]).exitCode).toBe(1);
}, 20_000);
