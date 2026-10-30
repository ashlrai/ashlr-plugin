import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetLive } from "../servers/_fleet-live";
import { fleetSource } from "../servers/_fleet-source";
import { fleetGhosts, type GhostDeps } from "../scripts/fleet-ghosts";

let runs: string, run: string;
const NOW = Date.parse("2026-10-30T12:00:00Z");
const EMPTY_LIVE = { live: [], ghosts: [], held: [], live_known: true,
  counts: { live: 0, ghosts: 0, held: 0 }, errors: {} };

const lane = (name: string) => { const dir = join(run, name); mkdirSync(dir, { recursive: true }); return dir; };
const base = (dir: string, job: string) => mkdirSync(join(dir, `${job}.base`), { recursive: true });
const touch = (dir: string, name: string) => writeFileSync(join(dir, name), "x\n");
const phdrip = (dir: string, job: string) => writeFileSync(join(dir, `${job}.phdrip`), "hold\n");
const deps = (lines: string[], extra: { alive?: (pid: number) => boolean } = {}): GhostDeps =>
  ({ procs: () => lines, now: () => NOW, ...extra });
const ghostNames = (injected: GhostDeps) =>
  fleetGhosts(run, injected).lanes
    .flatMap(l => l.ghosts.map(name => l.lane === "." ? name : `${l.lane}/${name}`))
    .sort((a, b) => a.localeCompare(b));
const snapshotTree = (dir: string): Record<string, string> => Object.fromEntries(
  readdirSync(dir, { recursive: true, encoding: "utf8" }).sort().map(name => {
    const stat = lstatSync(join(dir, name));
    return [name, stat.isFile() ? readFileSync(join(dir, name), "utf8") : `mode:${stat.mode & 0o777}`] as const;
  }));

beforeEach(() => {
  runs = realpathSync(mkdtempSync(join(tmpdir(), "fleet-live-")));
  run = join(runs, "queue", "run");
  mkdirSync(run, { recursive: true });
});
afterEach(() => rmSync(runs, { recursive: true, force: true }));

/** Fixture covering all three states: one live job per lane shape, one ghost
 *  worktree, one stalled job (reported but dead — in no bucket) and
 *  phdrip-held jobs both in a lane and at the run root. */
function fixture() {
  const dev = lane("dev");
  base(dev, "job-live"); touch(dev, "job-live.log");
  base(dev, "job-ghost"); touch(dev, "job-ghost.log.gz");
  base(dev, "job-stall"); touch(dev, "job-stall.log");
  phdrip(dev, "job-lane-held");
  base(run, "job-root"); touch(run, "job-root.log");
  phdrip(run, "job-held-1"); phdrip(run, "job-held-2");
  return deps([`bun ${join(dev, "job-live.base")}/serve.ts`, `bun ${join(run, "job-root.base")}/run.ts`]);
}

test("splits jobs into live, ghost and held across lanes and the run root", () => {
  const split = fleetLive(runs, fixture());
  expect(split).toEqual({
    live: ["dev/job-live", "job-root"],
    ghosts: ["dev/job-ghost"],
    held: ["dev/job-lane-held", "job-held-1", "job-held-2"],
    live_known: true,
    counts: { live: 2, ghosts: 1, held: 3 },
    errors: {},
  });
});

test("held equals the phdrip count and ghosts match fleet-ghosts", () => {
  const injected = fixture();
  const split = fleetLive(runs, injected);
  // Three marker files on disk, three held entries — one in a lane, two at root.
  expect(split.held).toHaveLength(3);
  expect(split.counts.held).toBe(3);
  // The ghost bucket is exactly what the fleet-ghosts report emits, qualified.
  expect(split.ghosts).toEqual(ghostNames(injected));
});

test("a stalled job is neither live, ghost nor held", () => {
  const split = fleetLive(runs, fixture());
  expect(split.live).not.toContain("dev/job-stall");
  expect(split.ghosts).not.toContain("dev/job-stall");
  expect(split.held).not.toContain("dev/job-stall");
});

test("held markers: bare .phdrip, dirs, links and dot-lanes are not held jobs", () => {
  phdrip(run, "job-held");
  touch(run, ".phdrip");                          // empty stem — not a job name
  mkdirSync(join(run, "job-dir.phdrip"));         // a directory, not a marker
  symlinkSync(join(run, "real-target"), join(run, "job-link.phdrip"));
  const hidden = join(run, ".hidden"); mkdirSync(hidden, { recursive: true });
  phdrip(hidden, "job-secret");                   // dot dirs are not lanes
  const split = fleetLive(runs, deps([]));
  expect(split.held).toEqual(["job-held"]);
  expect(split.counts.held).toBe(1);
});

test("a live pid file keeps a job live when the process table is unavailable", () => {
  const dev = lane("dev");
  base(dev, "job-pid"); touch(dev, "job-pid.log"); writeFileSync(join(dev, "job-pid.pid"), "4321\n");
  base(dev, "job-dead"); touch(dev, "job-dead.log.gz");
  const split = fleetLive(runs, {
    procs: () => { throw new Error("ps failed"); }, alive: pid => pid === 4321, now: () => NOW,
  });
  expect(split.live_known).toBe(false);
  expect(split.live).toEqual(["dev/job-pid"]);
  expect(split.ghosts).toEqual([]); // liveness unknown: no ghost verdicts
  expect(split.errors["processes"]).toBe("unavailable");
});

test("missing, linked or file queue/run is an empty split, never an error", () => {
  rmSync(run, { recursive: true });
  expect(fleetLive(runs, deps([]))).toEqual(EMPTY_LIVE);
  expect(fleetSource(runs, deps([])).errors["live.json"]).toBeUndefined();
  writeFileSync(run, "not a dir");
  expect(fleetLive(runs, deps([]))).toEqual(EMPTY_LIVE);
  rmSync(run);
  const elsewhere = join(runs, "elsewhere"); mkdirSync(elsewhere);
  symlinkSync(elsewhere, run);
  expect(fleetLive(runs, deps([]))).toEqual(EMPTY_LIVE);
});

test("fleetSource merges the split under live and keeps the other sources", () => {
  writeFileSync(join(runs, "queue", "slots.json"), '{"dev":2}');
  writeFileSync(join(runs, "queue", "dispatch-events.log"), '[2026-10-30T12:00:00Z] dispatched job=RQ-1\n');
  mkdirSync(join(runs, "metrics"), { recursive: true });
  writeFileSync(join(runs, "metrics", "jobs.jsonl"), '{"job_id":"RQ-1","pool":"dev","state":"running"}\n');
  const injected = fixture();
  const state = fleetSource(runs, injected);
  expect(state.live).toEqual(fleetLive(runs, injected));
  expect(state.live.counts).toEqual({ live: 2, ghosts: 1, held: 3 });
  expect(state.targets).toEqual({ dev: 2 });
  expect(state.jobs).toEqual([{ job_id: "RQ-1", pool: "dev", state: "running" }]);
  expect(state.errors).toEqual({});
});

test("fleetSource surfaces a live-scan failure under the canonical live.json key", () => {
  fixture();
  const state = fleetSource(runs, { procs: () => { throw new Error("ps failed"); } });
  expect(state.live.live_known).toBe(false);
  expect(state.live.errors["processes"]).toBe("unavailable");
  expect(state.errors["live.json"]).toBe("unavailable");
});

test("read-only: the runs tree is byte-identical after the split", () => {
  const injected = fixture();
  const before = snapshotTree(runs);
  fleetLive(runs, injected);
  fleetSource(runs, injected);
  expect(snapshotTree(runs)).toEqual(before);
});
