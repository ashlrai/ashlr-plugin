import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectFleetResources, fleetResources, writeAtomic } from "../scripts/fleet-resources.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const backend = (backend: string, extra: Record<string, unknown> = {}) => ({
  backend, availability: "open", usedPct: null, cap: null, capUnit: null, capWindow: null,
  resetsAt: null, costPerMTokenOut: 0, p50LatencyMs: null, snapshotAt: at(-60_000),
  reason: "fixture", backoffUntilMs: null, ...extra,
});
const monitor = (backends: unknown[]) => JSON.stringify({ generatedAt: at(-1000), backends });
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");
const SIX = [backend("builtin"), backend("claude"), backend("codex"),
  backend("kimi"), backend("local-coder"), backend("nim")];

test("joins monitor snapshot, slot targets and job metrics into one ledger", () => {
  const jobs = lines([
    { job: "J1", lane: "claude", event: "launch", ts: at(-30 * 60_000), tokens: 100 },
    { job: "J1", event: "finish", ts: at(-10 * 60_000), tokens: 340 }, // lane resolves via J1
    { job: "J2", lane: "devin", event: "launch", ts: at(-20 * 60_000) },
    { job: "J2", event: "running", ts: at(-19 * 60_000) },
    { job: "J3", lane: "claude", event: "queued", ts: at(-5 * 60_000) },
  ]);
  const ledger = fleetResources({
    monitor: monitor([
      backend("claude", { usedPct: 40, cap: 200, capUnit: "tokens", capWindow: "5h",
        resetsAt: 1_893_456_000, costPerMTokenOut: 0, reason: "budget reader" }),
      backend("builtin"),
    ]),
    slots: JSON.stringify({ claude: { target: 3 }, devin: { target: 4, held: true } }),
    jobs,
  }, 1, NOW);
  expect(ledger.sources).toEqual({ monitor: "ok", slots: "ok", jobs: "ok" });
  expect(Object.keys(ledger.lanes)).toEqual(["builtin", "claude", "devin"]);
  const claude = ledger.lanes.claude!;
  expect(claude.availability).toBe("open");
  expect(claude.left).toBe(120); // 200 * (1 - 40/100)
  expect(claude.resetsAt).toBe(new Date(1_893_456_000_000).toISOString());
  expect(claude.slotsTarget).toBe(3);
  expect(claude.jobsPerHour).toBe(2); // J1 and J3 active in the hour
  expect(claude.tokensPerHour).toBe(340); // J1: 100 first reading + 240 delta
  expect(claude.slotsRunning).toBe(0); // J1 finished, J3 queued
  expect(claude.slotsLeft).toBe(3);
  expect(claude.projectedExhaustionAt).toBe(new Date(NOW + (120 / 340) * HOUR).toISOString());
  const devin = ledger.lanes.devin!;
  expect(devin.availability).toBeNull(); // not a monitor backend
  expect(devin.slotsTarget).toBe(4);
  expect(devin.held).toBe(true);
  expect(devin.slotsRunning).toBe(1);
  expect(devin.slotsLeft).toBe(3);
  expect(ledger.lanes.builtin!.slotsRunning).toBe(0);
});

test("every field is null when all sources are absent", () => {
  const ledger = fleetResources({ monitor: null, slots: null, jobs: null }, 6, NOW);
  expect(ledger).toMatchObject({ schemaVersion: 1, windowHours: 6,
    sources: { monitor: "missing", slots: "missing", jobs: "missing" }, lanes: {} });
  expect(ledger.generatedAt).toBe(at(0));
  const absent = { monitor: null, slots: null, jobs: null };
  for (const hours of [0, -1, NaN, Infinity, 1e306]) expect(() => fleetResources(absent, hours, NOW)).toThrow();
  for (const now of [NaN, Infinity]) expect(() => fleetResources(absent, 6, now)).toThrow();
});

test("monitor-only run still reports its lanes with unknown ledger fields", () => {
  const ledger = fleetResources({ monitor: monitor(SIX), slots: null, jobs: null }, 6, NOW);
  expect(Object.keys(ledger.lanes)).toEqual(["builtin", "claude", "codex", "kimi", "local-coder", "nim"]);
  for (const lane of Object.values(ledger.lanes)) {
    expect(lane.jobsPerHour).toBeNull();
    expect(lane.tokensPerHour).toBeNull();
    expect(lane.slotsLeft).toBeNull();
    expect(lane.projectedExhaustionAt).toBeNull();
  }
});

test("malformed sources are invalid; malformed jobs lines are skipped", () => {
  const ledger = fleetResources({
    monitor: "{broken", slots: "[1,2,3]", jobs: `not json\n{"job":"J1","lane":"claude","event":"launch","ts":"${at(-1000)}"}\n{partial`,
  }, 1, NOW);
  expect(ledger.sources).toEqual({ monitor: "invalid", slots: "invalid", jobs: "ok" });
  expect(ledger.lanes.claude?.slotsRunning).toBe(1);
});

test("window edges are inclusive; token deltas clamp at zero and attribute by job lane", () => {
  const jobs = lines([
    { job: "J1", lane: "claude", event: "launch", ts: at(-3 * HOUR), tokens: 50 },
    { job: "J1", ts: at(-2 * HOUR), tokens: 150 },            // in window: +100 (boundary inclusive)
    { job: "J1", ts: at(-30 * 60_000), tokens: 120 },         // regression: +0
    { job: "J1", ts: at(-1), tokens: 160 },                   // +40
    { job: "J2", lane: "claude", ts: at(-2 * HOUR - 1), tokens: 999 }, // before window: ignored
    { job: "J2", ts: at(-60_000), tokens: 1080 },             // +81
    { job: "J2", ts: at(60_000), tokens: 2000 },              // future: ignored
    { job: "J3", event: "launch", ts: at(-1000), tokens: 5 }, // no lane: dropped
  ]);
  const ledger = fleetResources({ monitor: null, slots: null, jobs }, 2, NOW);
  expect(ledger.lanes.claude?.tokensPerHour).toBe(110.5); // (100 + 40 + 81) / 2
  expect(ledger.lanes.claude?.jobsPerHour).toBe(1);       // J1 and J2 = 2 jobs / 2h
  expect(ledger.lanes.J3).toBeUndefined();
});

test("latest recognized transition decides slot occupancy", () => {
  const rows = (seq: string[]) => seq.map((transition, i) =>
    ({ job: `J-${transition}-${i}`, lane: "devin", event: transition, ts: at(-i * 1000) }));
  const jobs = lines([
    { job: "A", lane: "devin", event: "launch", ts: at(-60_000) },
    { job: "A", event: "finish", ts: at(-50_000) },                        // settled
    { job: "B", lane: "devin", event: "launch", ts: at(-40_000) },
    { job: "B", event: "mystery-event", ts: at(-30_000) },                 // still live
    { job: "C", lane: "devin", state: "RUNNING", ts: at(-20_000) },        // alias, case-insensitive
    { job: "D", lane: "devin", outcome: "running", ts: at(-15_000) },      // metrics-feed field
    { job: "E", lane: "devin", event: "launch", ts: at(-10_000) },
    { job: "E", event: "retried", ts: at(-5_000) },                        // back to queue
    ...rows(["queued"]),
  ]);
  const ledger = fleetResources({ monitor: null, slots: JSON.stringify({ devin: { target: 2 } }), jobs }, 6, NOW);
  expect(ledger.lanes.devin?.slotsRunning).toBe(3); // B, C, D
  expect(ledger.lanes.devin?.slotsLeft).toBe(0);    // clamped at zero, never negative
});

test("projected exhaustion respects capUnit and missing rates", () => {
  const jobs = lines([{ job: "J1", lane: "a", event: "launch", ts: at(-60_000), tokens: 60 }]);
  const base = { monitor: null as string | null, slots: null, jobs };
  const proj = (extra: Record<string, unknown>, h = 1) => fleetResources(
    { ...base, monitor: monitor([backend("a", extra)]) }, h, NOW).lanes.a!.projectedExhaustionAt;
  expect(proj({ usedPct: 50, cap: 120, capUnit: "tokens" })).toBe(new Date(NOW + HOUR).toISOString());
  expect(proj({ usedPct: 50, cap: 120, capUnit: "messages" })).toBe(new Date(NOW + 60 * HOUR).toISOString());
  expect(proj({ usedPct: 50, cap: 120, capUnit: "concurrent" })).toBeNull();
  expect(proj({ usedPct: 100, cap: 120, capUnit: "tokens" })).toBe(at(0));
  expect(proj({ usedPct: 140, cap: 120, capUnit: "tokens" })).toBe(at(0)); // over-cap is now
  expect(proj({ usedPct: 50, capUnit: "tokens" })).toBeNull();            // left unknown
  expect(proj({ usedPct: 50, cap: 120, capUnit: "tokens" }, 6)).toBe(new Date(NOW + (60 / 10) * HOUR).toISOString());
});

test("resetsAt epoch seconds and backoffUntilMs convert to ISO timestamps", () => {
  const ledger = fleetResources({ monitor: monitor([
    backend("claude", { resetsAt: 1_800_000_000, backoffUntilMs: NOW + 5000 }),
    backend("codex", { resetsAt: -5 }),
  ]), slots: null, jobs: null }, 6, NOW);
  expect(ledger.lanes.claude?.resetsAt).toBe(new Date(1_800_000_000_000).toISOString());
  expect(ledger.lanes.claude?.backoffUntil).toBe(at(5000));
  expect(ledger.lanes.codex?.resetsAt).toBeNull();
});

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet-resources-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("writeAtomic replaces contents without partial reads or leftovers", () => {
  writeAtomic(root, "resources.json", "first\n");
  const stale = join(root, "stale-target.json");
  writeFileSync(stale, "untouched");
  rmSync(join(root, "resources.json"));
  symlinkSync(stale, join(root, "resources.json"));
  writeAtomic(root, "resources.json", "second\n");
  expect(readFileSync(stale, "utf8")).toBe("untouched"); // rename replaces the link, not its target
  expect(lstatSync(join(root, "resources.json")).isFile()).toBe(true);
  expect(readFileSync(join(root, "resources.json"), "utf8")).toBe("second\n");
  expect(readdirSync(root).sort()).toEqual(["resources.json", "stale-target.json"]);
  expect(() => writeAtomic(stale, "resources.json", "x")).toThrow(); // not a directory
});

test("collectFleetResources reads fixed files, maps errors and accepts an injected monitor", () => {
  const runs = join(root, ".ashlr-runs");
  let ledger = collectFleetResources(runs, 6, NOW, () => monitor(SIX));
  expect(ledger.sources).toEqual({ monitor: "ok", slots: "missing", jobs: "missing" });
  expect(Object.keys(ledger.lanes)).toHaveLength(6);
  mkdirSync(join(runs, "queue"), { recursive: true });
  mkdirSync(join(runs, "metrics"), { recursive: true });
  writeFileSync(join(runs, "queue", "slots.json"), JSON.stringify({ devin: { target: 2 } }));
  symlinkSync(join(runs, "queue", "slots.json"), join(runs, "metrics", "jobs.jsonl"));
  ledger = collectFleetResources(runs, 6, NOW, () => { throw new Error("no ashlr"); });
  expect(ledger.sources).toEqual({ monitor: "unavailable", slots: "ok", jobs: "unavailable" });
  expect(ledger.lanes.devin?.slotsTarget).toBe(2);
});

const run = (args: string[] = [], env: Record<string, string> = {}) => Bun.spawnSync(
  [process.execPath, join(import.meta.dir, "../scripts/fleet-resources.ts"), ...args],
  { cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin", ...env } });

test("CLI joins a stubbed monitor with ~/.ashlr-runs and rewrites resources.json atomically", () => {
  const runs = join(root, ".ashlr-runs");
  mkdirSync(join(runs, "queue"), { recursive: true });
  mkdirSync(join(runs, "metrics"), { recursive: true });
  writeFileSync(join(runs, "queue", "slots.json"), JSON.stringify({ claude: { target: 2 } }));
  writeFileSync(join(runs, "metrics", "jobs.jsonl"), lines([
    { job: "J1", lane: "claude", event: "launch", ts: new Date(Date.now() - 60_000).toISOString(), tokens: 90 }]));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stub = join(bin, "ashlr");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s' '${monitor(SIX)}'\n`);
  chmodSync(stub, 0o755);
  const result = run([], { PATH: `${bin}:/usr/bin:/bin` });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const ledger = JSON.parse(result.stdout.toString());
  expect(Object.keys(ledger.lanes)).toEqual(["builtin", "claude", "codex", "kimi", "local-coder", "nim"]);
  expect(ledger.sources).toEqual({ monitor: "ok", slots: "ok", jobs: "ok" });
  expect(ledger.lanes.claude.tokensPerHour).toBeGreaterThan(0);
  expect(ledger.lanes.claude.slotsRunning).toBe(1);
  expect(readFileSync(join(runs, "resources.json"), "utf8")).toBe(result.stdout.toString());
  expect(readdirSync(runs).sort()).toEqual(["metrics", "queue", "resources.json"]);
});

test("CLI without ashlr still writes a ledger of unknown lanes", () => {
  const result = run();
  expect(result.exitCode).toBe(0);
  const ledger = JSON.parse(result.stdout.toString());
  expect(ledger.sources).toEqual({ monitor: "unavailable", slots: "missing", jobs: "missing" });
  expect(ledger.lanes).toEqual({});
  expect(readFileSync(join(root, ".ashlr-runs", "resources.json"), "utf8")).toBe(result.stdout.toString());
});

test("CLI rejects unsupported or invalid arguments", () => {
  mkdirSync(join(root, ".ashlr-runs"), { recursive: true });
  for (const args of [["--hours", "0"], ["--hours", "NaN"], ["--unknown"], ["extra"], ["--hours"]]) {
    const result = run(args);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("Usage: bun scripts/fleet-resources.ts [--hours N]");
  }
  expect(readdirSync(join(root, ".ashlr-runs"))).toEqual([]);
});
