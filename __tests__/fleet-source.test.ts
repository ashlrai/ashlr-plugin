import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetSource, readRunsText } from "../servers/_fleet-source";
import { fleetState, readFleetJobsText } from "../servers/fleet-state-server-handlers";
import { fleetSteer } from "../scripts/fleet-steer";
import { fleetSnapshot } from "../scripts/fleet-snapshot";

let home: string, fleet: string, runs: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "fleet-source-")));
  fleet = join(home, ".ashlr", "fleet");
  runs = join(home, ".ashlr-runs");
  mkdirSync(join(runs, "queue"), { recursive: true });
  mkdirSync(join(runs, "metrics"), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const runsWrite = (name: string, text: string) => writeFileSync(join(runs, name), text);
const snapshotTree = (dir: string): Record<string, string> => Object.fromEntries(
  readdirSync(dir, { recursive: true, encoding: "utf8" }).sort().map(name => {
    const path = join(dir, name), stat = lstatSync(path);
    return [name, stat.isFile() ? readFileSync(path, "utf8") : `mode:${stat.mode & 0o777}`] as const;
  }));

function fixture(jobCount = 25) {
  runsWrite("queue/slots.json", JSON.stringify({ dev: 2, ops: 1 }));
  runsWrite("HOLD", "quota pause\n");
  const jobs = Array.from({ length: jobCount }, (_, id) => ({ job_id: `RQ-${id}`, pool: id % 2 ? "ops" : "dev", state: "done" }));
  runsWrite("metrics/jobs.jsonl", jobs.map(job => JSON.stringify(job)).join("\n") + "\n");
  runsWrite("queue/dispatch-events.log",
    '[2026-10-30T11:00:00Z] dispatched job=RQ-1\n{"type":"leader","state":"elected","ts":"2026-10-30T12:00:00Z"}\n');
  return jobs;
}

test("maps slots, HOLD, job tail and last dispatch event to the fleetState shape", () => {
  const jobs = fixture();
  expect(fleetSource(runs)).toEqual({
    targets: { dev: 2, ops: 1 },
    holds: { dev: "quota pause", ops: "quota pause" },
    jobs: jobs.slice(5),
    leader_event: { type: "leader", state: "elected", ts: "2026-10-30T12:00:00Z" },
    errors: {},
  });
});

test("fleetState falls back to the runs tree only when every fleet file is absent", () => {
  fixture();
  const result = fleetState(fleet);
  expect(result.targets).toEqual({ dev: 2, ops: 1 });
  expect(result.holds).toEqual({ dev: "quota pause", ops: "quota pause" });
  expect(result.jobs).toHaveLength(20);
  // Any surviving fleet file keeps the old layout authoritative.
  mkdirSync(fleet, { recursive: true });
  writeFileSync(join(fleet, "targets.json"), '{"legacy":9}');
  writeFileSync(join(fleet, "jobs.jsonl"), '{"id":"RQ-old","state":"running"}\n');
  const partial = fleetState(fleet);
  expect(partial.targets).toEqual({ legacy: 9 });
  expect(partial.jobs).toEqual([{ id: "RQ-old", state: "running" }]);
  expect(partial.errors["holds.json"]).toBe("missing");
  expect(partial.errors["leader-events.jsonl"]).toBe("missing");
});

test("read-only: fixture bytes and the tree are identical after every read", () => {
  fixture();
  const before = snapshotTree(home);
  fleetSource(runs);
  fleetState(fleet);
  readFleetJobsText(fleet);
  fleetSteer(["lanes", "--root", fleet]);
  fleetSnapshot(undefined, fleet);
  expect(snapshotTree(home)).toEqual(before);
  expect(existsSync(fleet)).toBe(false); // reads never create the fleet dir
});

test("HOLD variants: per-lane JSON, lane list, empty file and absent sentinel", () => {
  runsWrite("queue/slots.json", '{"dev":2,"ops":1}');
  runsWrite("HOLD", '{"dev":"quota","ops":"review"}');
  expect(fleetSource(runs).holds).toEqual({ dev: "quota", ops: "review" });
  runsWrite("HOLD", '["dev"]');
  expect(fleetSource(runs).holds).toEqual({ dev: "held" });
  runsWrite("HOLD", "");
  expect(fleetSource(runs).holds).toEqual({ dev: "held", ops: "held" });
  rmSync(join(runs, "HOLD"));
  const result = fleetSource(runs);
  expect(result.holds).toEqual({});
  expect(result.errors["holds.json"]).toBeUndefined();
});

test("missing runs tree stays unknown; sentinel absence is not a hold claim", () => {
  rmSync(runs, { recursive: true });
  const result = fleetState(fleet);
  expect([result.targets, result.holds, result.jobs, result.leader_event]).toEqual([null, null, null, null]);
  expect(Object.values(result.errors)).toEqual(["missing", "missing", "missing", "missing"]);
});

test("strict job log and tolerant dispatch log report errors by canonical key", () => {
  runsWrite("queue/slots.json", '{"dev":1}');
  runsWrite("metrics/jobs.jsonl", '{"job_id":"RQ-1","state":"done"}\nbroken\n');
  runsWrite("queue/dispatch-events.log", 'noise line\n[2026-10-30T12:00:00Z] dispatched job=RQ-1\n');
  const result = fleetSource(runs);
  expect(result.jobs).toBeNull();
  expect(result.errors["jobs.jsonl"]).toBe("invalid");
  expect(result.leader_event).toEqual({ timestamp: "2026-10-30T12:00:00Z", type: "dispatched", job_id: "RQ-1" });
  expect(result.errors["leader-events.jsonl"]).toBe("invalid");
});

test("linked, hard-linked and oversized sources are unsafe or too_large", () => {
  fixture();
  writeFileSync(join(home, ".secret"), "sensitive-fixture");
  rmSync(join(runs, "queue"), { recursive: true });
  symlinkSync(join(runs, "metrics"), join(runs, "queue"));
  expect(fleetSource(runs).errors["targets.json"]).toBe("unsafe");
  rmSync(join(runs, "queue"));
  mkdirSync(join(runs, "queue"));
  linkSync(join(home, ".secret"), join(runs, "queue", "slots.json"));
  expect(fleetSource(runs).errors["targets.json"]).toBe("unsafe");
  const text = " ".repeat(4 * 1024 * 1024 + 1);
  writeFileSync(join(runs, "metrics", "jobs.jsonl"), text);
  expect(fleetSource(runs).errors["jobs.jsonl"]).toBe("too_large");
  for (const name of ["../.secret", "queue/../../.secret", "/etc/passwd", "logs/x.log"])
    expect(() => readRunsText(runs, name)).toThrow("unsafe");
});

test("unreadable HOLD fails closed: lanes report held with an error entry", () => {
  fixture();
  rmSync(join(runs, "HOLD"));
  linkSync(join(runs, "metrics", "jobs.jsonl"), join(runs, "HOLD"));
  const result = fleetSource(runs);
  expect(result.holds).toEqual({ dev: "held", ops: "held" });
  expect(result.errors["holds.json"]).toBe("unsafe");
});

test("full-log readers and lane views see runs jobs when the fleet log is absent", () => {
  const jobs = fixture();
  expect(readFleetJobsText(fleet).trim().split("\n")).toHaveLength(jobs.length);
  const result = fleetSteer(["lanes", "--root", fleet]);
  if (result.command !== "lanes") throw new Error("expected the lanes command");
  expect(result.lanes).toEqual({
    dev: { target: 2, hold: "quota pause", jobs: 13 },
    ops: { target: 1, hold: "quota pause", jobs: 12 },
  });
  const snapshot = fleetSnapshot(undefined, fleet);
  expect(snapshot.lanes).toMatchObject({ dev: { target: 2, hold: "quota pause" } });
  expect(Object.keys(snapshot.jobs as Record<string, unknown>)).toHaveLength(jobs.length);
});

test("MCP tool serves runs state under the fixed HOME layout", () => {
  fixture();
  const proc = Bun.spawnSync([process.execPath, "-e", `
    await import("./servers/fleet-state-server-handlers.ts");
    const { getTool } = await import("./servers/_tool-base.ts");
    const result = await getTool("ashlr__fleet_state").handler({}, { env: {} });
    console.log(result.content[0].text);
  `], { cwd: join(import.meta.dir, ".."), env: { HOME: home, PATH: "/usr/bin:/bin" } });
  expect(proc.exitCode).toBe(0);
  const result = JSON.parse(proc.stdout.toString());
  expect(result.targets).toEqual({ dev: 2, ops: 1 });
  expect(result.holds).toEqual({ dev: "quota pause", ops: "quota pause" });
  expect(result.jobs).toHaveLength(20);
  expect(result.leader_event).toMatchObject({ type: "leader" });
});
