import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetSnapshot } from "../scripts/fleet-snapshot";
let root: string;
const write = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value));
const jobs = (rows: unknown[]) => writeFileSync(join(root, "jobs.jsonl"), rows.map(row => JSON.stringify(row)).join("\n"));
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "snapshot-")));
  write("targets.json", { fake: 1 });
  write("holds.json", {});
  jobs([{ id: "fake-a", pool: "fake", state: "queued", pr_url: "https://example.test/pr/1" }]);
  writeFileSync(join(root, "leader-events.jsonl"), '{"event":"idle"}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
test("versioned snapshot and repeated cursor calls return only changes", () => {
  const first = fleetSnapshot(undefined, root);
  expect(first).toMatchObject({ schema_version: 1, lanes: { fake: { target: 1, hold: null } },
    jobs: { "fake-a": { state: "queued" } }, prs: { "fake-a": { url: "https://example.test/pr/1" } },
    leader: { event: "idle" }, errors: {}, removed: {} });
  expect(fleetSnapshot(first.cursor, root)).toEqual({ schema_version: 1, cursor: first.cursor, removed: {} });
  jobs([{ id: "fake-a", pool: "fake", state: "done", pr_url: "https://example.test/pr/1" }]);
  const second = fleetSnapshot(first.cursor, root);
  expect(Object.keys(second).sort()).toEqual(["cursor", "jobs", "removed", "schema_version"]);
  expect(second).toMatchObject({ jobs: { "fake-a": { state: "done" } } });
  expect(fleetSnapshot(second.cursor, root)).toEqual({ schema_version: 1, cursor: second.cursor, removed: {} });
});
test("tracks removals and all jobs beyond the UI tail", () => {
  jobs(Array.from({ length: 25 }, (_, i) => ({ id: `fake-${i}`, pool: "fake" })));
  const first = fleetSnapshot(undefined, root);
  expect(Object.keys(first.jobs as object)).toHaveLength(25);
  jobs([]);
  expect(fleetSnapshot(first.cursor, root)).toMatchObject({ removed: { jobs: Array.from({ length: 25 }, (_, i) => `fake-${i}`).sort((a, b) => a.localeCompare(b)) } });
});
test("latest job wins and PR removal and leader changes are deltas", () => {
  const first = fleetSnapshot(undefined, root);
  jobs([{ id: "fake-a", state: "queued" }, { id: "fake-a", state: "done" }]);
  writeFileSync(join(root, "leader-events.jsonl"), '{"event":"busy"}\n');
  expect(fleetSnapshot(first.cursor, root)).toMatchObject({ jobs: { "fake-a": { state: "done" } },
    leader: { event: "busy" }, removed: { prs: ["fake-a"] } });
});
test("unsafe and invalid sources are unknown and recovery restores data", () => {
  const first = fleetSnapshot(undefined, root);
  rmSync(join(root, "jobs.jsonl"));
  symlinkSync(join(root, "targets.json"), join(root, "jobs.jsonl"));
  const unavailable = fleetSnapshot(first.cursor, root);
  expect(unavailable).toMatchObject({ jobs: null, prs: null, errors: { "jobs.jsonl": "unsafe" }, removed: {} });
  expect(fleetSnapshot(unavailable.cursor, root)).toEqual({ schema_version: 1, cursor: unavailable.cursor, removed: {} });
  rmSync(join(root, "jobs.jsonl"));
  jobs([{ id: "fake-b" }]);
  expect(fleetSnapshot(unavailable.cursor, root)).toMatchObject({ jobs: { "fake-b": { id: "fake-b" } }, errors: {} });
});
test("rejects malformed, incompatible and foreign cursors", () => {
  for (const cursor of ["bad", "{}", "null", JSON.stringify({ version: 2 })])
    expect(() => fleetSnapshot(cursor, root)).toThrow("invalid snapshot cursor");
  expect(() => fleetSnapshot(fleetSnapshot(undefined, root).cursor, join(root, "other"))).toThrow();
});

test("CLI emits one JSON document and rejects bad arguments", () => {
  const run = (args: string[]) => Bun.spawnSync([process.execPath, "scripts/fleet-snapshot.ts", ...args], {
    cwd: join(import.meta.dir, ".."), env: { HOME: root, PATH: "/usr/bin:/bin" },
  });
  const first = run([]);
  expect(first.exitCode).toBe(0);
  const snapshot = JSON.parse(first.stdout.toString());
  const next = run(["--since", snapshot.cursor]);
  expect(JSON.parse(next.stdout.toString())).toEqual({ schema_version: 1, cursor: snapshot.cursor, removed: {} });
  expect(run(["--bad"]).exitCode).toBe(1);
}, 20_000);
