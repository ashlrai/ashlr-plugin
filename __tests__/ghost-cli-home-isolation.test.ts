import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const homes: string[] = [];
function home(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ghost-home-")));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ghost = (dir: string, job: string) => {
  mkdirSync(join(dir, `${job}.base`), { recursive: true });
  writeFileSync(join(dir, `${job}.log.gz`), "x\n");
};

// The spawned CLI needs a real HOME (bun drops ~/.bun, macOS ~/Library), but
// those siblings of the runs dir must never surface as lanes. Seed HOME with
// debris shaped exactly like ghost jobs so a HOME leak cannot pass silently.
const run = (dir: string, path: string) => Bun.spawnSync(
  [process.execPath, join(root, "scripts/fleet-ghosts.ts"), path],
  { env: { HOME: dir, PATH: "/usr/bin:/bin" }, timeout: 10_000 },
);

test("debris in HOME never leaks into the lanes report", () => {
  const dir = home();
  const runs = join(dir, "runs");
  mkdirSync(runs);
  ghost(join(dir, "Library"), "job-macos");   // the lane CI actually observed
  ghost(join(dir, ".bun"), "job-cache");
  const empty = run(dir, runs);
  expect(empty.exitCode).toBe(0);
  expect(empty.stderr.toString()).toBe("");
  const report = JSON.parse(empty.stdout.toString());
  expect(report.runs).toBe(resolve(runs));
  expect(report).toMatchObject({ lanes: [], counts: { lanes: 0, ghosts: 0 } });
}, 20_000);

test("lanes come from the runs dir while HOME stays polluted", () => {
  const dir = home();
  const runs = join(dir, "runs");
  const laneDir = join(runs, "fake-lane");
  mkdirSync(laneDir, { recursive: true });
  ghost(laneDir, "job-dead");
  ghost(join(dir, "Library"), "job-macos");
  const scan = run(dir, runs);
  expect(scan.exitCode).toBe(0);
  expect(scan.stderr.toString()).toBe("");
  const report = JSON.parse(scan.stdout.toString());
  expect(report.lanes.map((l: { lane: string }) => l.lane)).toEqual(["fake-lane"]);
  expect(report.lanes[0]).toMatchObject({ reported: 0, ghosts: ["job-dead"] });
  expect(report.counts).toMatchObject({ lanes: 1, ghosts: 1 });
}, 20_000);
