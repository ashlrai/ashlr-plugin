import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetThread } from "../scripts/fleet-thread.ts";

const id = "RQ-1.test_2";
const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");
const event = (type: string, ts?: string, extra = {}) => ({ job_id: id, type, ts, ...extra });
const at = (minute: string) => `2026-10-30T12:${minute}:00.000Z`;

test("merges chronologically across sources with aliases, time zones and stable ties", () => {
  const jobs = lines(event("done", at("03")), { job: id, event: "running", time: at("01") },
    { id, status: "merged", timestamp: "2026-10-30T08:02:00-04:00" });
  const dispatch = lines(event("dispatched", at("01")), event("retried", at("01")), event("queued", at("00")));
  expect(fleetThread(id, jobs, dispatch)).toEqual([
    { source: "queue/dispatch-events.log", line: 3, type: "queued", timestamp: at("00"), job_id: id },
    { source: "queue/dispatch-events.log", line: 1, type: "dispatched", timestamp: at("01"), job_id: id },
    { source: "queue/dispatch-events.log", line: 2, type: "retried", timestamp: at("01"), job_id: id },
    { source: "metrics/jobs.jsonl", line: 2, type: "running", timestamp: at("01"), job_id: id },
    { source: "metrics/jobs.jsonl", line: 3, type: "merged", timestamp: at("02"), job_id: id },
    { source: "metrics/jobs.jsonl", line: 1, type: "done", timestamp: at("03"), job_id: id },
  ]);
});

test("unknown jobs and empty inputs return an empty timeline; IDs match exactly", () => {
  expect(fleetThread("unknown", lines(event("done")), "")).toEqual([]);
  expect(fleetThread(id, "", "")).toEqual([]);
  expect(fleetThread(id, lines(event("done", undefined, { job_id: `${id}-other` })),
    `${at("00")} dispatched job=${id}/other`)).toEqual([]);
});

test("rejects bad IDs in the pure parser", () => {
  for (const bad of ["", "../job", "job/path", "job\\path", "job name", "job\n", "job\0", "job?", "é", undefined])
    expect(() => fleetThread(bad as string, "", "")).toThrow("Invalid job ID");
});

test("skips malformed lines, accepts dispatch text and omits arbitrary log fields", () => {
  const jobs = `broken\n${lines(null, [], 42, {}, { job_id: id }, event("done", at("02"), { private: "fixture-only" }))}\n{partial`;
  const dispatch = `bad\n\n[${at("00")}] dispatched job=${id} private=fixture-only\r\n${at("01")} started job_id=${id}\n`;
  const result = fleetThread(id, jobs, dispatch);
  expect(result.map(row => [row.type, row.line])).toEqual([["dispatched", 3], ["started", 4], ["done", 7]]);
  expect(JSON.stringify(result)).not.toContain("fixture-only");
});

test("undated and invalid-time events sort last in stable source/line order", () => {
  const result = fleetThread(id, lines(event("missing"), event("invalid", "bad"), event("done", at("01"))),
    lines(event("undated")));
  expect(result.map(row => [row.type, row.timestamp])).toEqual([
    ["done", at("01")], ["undated", null], ["missing", null], ["invalid", null],
  ]);
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "fleet-thread-")); roots.push(home);
  const jobs = join(home, ".ashlr-runs/metrics/jobs.jsonl"), dispatch = join(home, ".ashlr-runs/queue/dispatch-events.log");
  for (const dir of ["metrics", "queue"]) mkdirSync(join(home, ".ashlr-runs", dir), { recursive: true });
  writeFileSync(jobs, lines(event("done", at("02"))));
  writeFileSync(dispatch, `${at("00")} dispatched job=${id}\n`);
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/fleet-thread.ts"), ...args],
    { cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin" } });
  return { home, jobs, dispatch, run };
}

test("CLI uses the two fixed HOME paths and prints only JSON, including unknown jobs", () => {
  const { run } = fixture(), result = run(id);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString()).map((row: { type: string }) => row.type)).toEqual(["dispatched", "done"]);
  expect(JSON.parse(run("unknown").stdout.toString())).toEqual([]);
});

for (const args of [[], ["../private-fixture"], ["bad\n"], [id, "extra"], [id, "--input", "private-fixture"]])
test(`CLI rejects invalid arguments without echoing input: ${JSON.stringify(args)}`, () => {
  const result = fixture().run(...args);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain("Usage:");
  expect(result.stderr.toString()).not.toContain("private-fixture");
});

test("CLI fails without emitting a partial timeline when a source is missing", () => {
  const { run, jobs } = fixture();
  rmSync(jobs);
  const missing = run(id);
  expect(missing.exitCode).toBe(1); expect(missing.stdout.toString()).toBe("");
});

for (const kind of ["file", "directory", "hardlink", "oversized"])
test(`CLI rejects unsafe sources: ${kind}`, () => {
  const { run, home, jobs, dispatch } = fixture();
  rmSync(dispatch);
  if (kind === "directory") {
    rmSync(join(home, ".ashlr-runs/queue"), { recursive: true });
    symlinkSync(join(home, ".ashlr-runs/metrics"), join(home, ".ashlr-runs/queue"));
  } else if (kind === "file") symlinkSync(jobs, dispatch);
  else if (kind === "hardlink") linkSync(jobs, dispatch);
  else { writeFileSync(dispatch, ""); truncateSync(dispatch, 4 * 1024 * 1024 + 1); }
  const result = run(id);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
});
