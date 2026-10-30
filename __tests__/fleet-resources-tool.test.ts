import { afterEach, beforeEach, expect, test } from "bun:test";
import { timingBudgetMs } from "../scripts/timing-budget";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetResourcesCall } from "../servers/fleet-resources-server-handlers";
import { getTool, type ToolResult } from "../servers/_tool-base";
import { ensureFleetResources, RESOURCES_TTL_MS } from "../scripts/fleet-resources.ts";
import { startFleetUi } from "../scripts/fleet-ui-server.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const backend = (backend: string, extra: Record<string, unknown> = {}) => ({
  backend, availability: "open", usedPct: null, cap: null, capUnit: null, capWindow: null,
  resetsAt: null, costPerMTokenOut: 0, p50LatencyMs: null, snapshotAt: new Date(NOW - 60_000).toISOString(),
  reason: "fixture", backoffUntilMs: null, ...extra,
});
const SIX = [backend("builtin"), backend("claude"), backend("codex"),
  backend("kimi"), backend("local-coder"), backend("nim")];
const SIX_LANES = ["builtin", "claude", "codex", "kimi", "local-coder", "nim"];
const monitor = (backends: unknown[] = SIX) => JSON.stringify({ generatedAt: new Date(NOW - 1000).toISOString(), backends });
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");
const json = (result: ToolResult) => { expect(result.isError).toBeUndefined(); return JSON.parse(result.content[0]!.text); };

let home: string;
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), "fleet-resources-tool-"))); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const seedRuns = (runs: string, base = Date.now()) => {
  const stamp = (offsetMs: number) => new Date(base + offsetMs).toISOString();
  mkdirSync(join(runs, "queue"), { recursive: true });
  mkdirSync(join(runs, "metrics"), { recursive: true });
  writeFileSync(join(runs, "queue", "slots.json"), JSON.stringify({ claude: { target: 2 }, devin: { target: 1 } }));
  writeFileSync(join(runs, "metrics", "jobs.jsonl"), lines([
    { job: "J1", lane: "claude", event: "launch", ts: stamp(-30 * 60_000), tokens: 120 },
    { job: "J1", event: "finish", ts: stamp(-10 * 60_000), tokens: 300 },
    { job: "J2", lane: "devin", event: "launch", ts: stamp(-5 * 60_000), tokens: 40 },
  ]));
};

test("tool call writes a missing ledger with real lane numbers, then serves it fresh", () => {
  const runs = join(home, ".ashlr-runs");
  seedRuns(runs);
  let calls = 0;
  const count = () => { calls += 1; return monitor(); };
  const first = json(fleetResourcesCall({}, runs, Date.now(), count));
  expect(first.refreshed).toBe(true);
  expect(calls).toBe(1);
  expect(Object.keys(first.lanes)).toEqual([...SIX_LANES, "devin"].sort());
  expect(first.lanes.claude).toMatchObject({ availability: "open", slotsTarget: 2, slotsRunning: 0, jobsPerHour: 0.167 });
  expect(first.lanes.claude.tokensPerHour).toBe(50);
  expect(first.lanes.devin).toMatchObject({ slotsTarget: 1, slotsRunning: 1, slotsLeft: 0 });
  const onDisk = JSON.parse(readFileSync(join(runs, "resources.json"), "utf8"));
  expect(onDisk.schemaVersion).toBe(1);
  expect(Math.abs(Date.now() - Date.parse(onDisk.generatedAt))).toBeLessThan(10_000);
  expect(onDisk.refreshed).toBeUndefined(); // the flag is call metadata, never persisted
  const second = json(fleetResourcesCall({}, runs, Date.now(), count));
  expect(second.refreshed).toBe(false);       // within 60s: no re-run
  expect(calls).toBe(1);
  expect(second.generatedAt).toBe(first.generatedAt);
});

test("stale, corrupt, unsafe and future-dated caches all regenerate", () => {
  const runs = join(home, ".ashlr-runs"), file = join(runs, "resources.json");
  mkdirSync(runs, { recursive: true });
  let calls = 0;
  const count = () => { calls += 1; return monitor(); };
  const seed = (offsetMs: number, lanes: unknown = { ghost: { availability: "cached" } }) =>
    JSON.stringify({ generatedAt: new Date(Date.now() + offsetMs).toISOString(), lanes });
  const backdate = (offsetMs: number) => utimesSync(file, new Date(Date.now() + offsetMs), new Date(Date.now() + offsetMs));
  for (const [label, contents] of [
    ["stale generatedAt", seed(-RESOURCES_TTL_MS - 1000)],
    ["corrupt", "{partial"],
    ["array lanes", seed(-1000, [])],
    ["future generatedAt", seed(RESOURCES_TTL_MS + 1000)],
  ] as const) {
    writeFileSync(file, contents);
    const result = json(fleetResourcesCall({}, runs, Date.now(), count));
    expect(result.refreshed, label).toBe(true);
  }
  expect(calls).toBe(4);
  // An old mtime alone is stale too, even when generatedAt looks fresh.
  writeFileSync(file, seed(-1000));
  backdate(-RESOURCES_TTL_MS - 1000);
  expect(json(fleetResourcesCall({}, runs, Date.now(), count)).refreshed).toBe(true);
  expect(calls).toBe(5);
  const target = join(runs, "linked.txt");
  writeFileSync(target, "untouched");
  rmSync(file);
  symlinkSync(target, file);
  expect(json(fleetResourcesCall({}, runs, Date.now(), count)).refreshed).toBe(true);
  expect(calls).toBe(6);
  expect(readFileSync(target, "utf8")).toBe("untouched");
  // Both clocks inside the window (1s of margin) serve the cached ledger.
  for (const offset of [-RESOURCES_TTL_MS + 1000, RESOURCES_TTL_MS - 1000]) {
    writeFileSync(file, seed(offset));
    const result = json(fleetResourcesCall({}, runs, Date.now(), count));
    expect(result.refreshed).toBe(false);
    expect(result.lanes.ghost.availability).toBe("cached");
  }
  expect(calls).toBe(6);
});

test("the 60-second boundary is inclusive on both clocks", () => {
  const runs = join(home, ".ashlr-runs"), file = join(runs, "resources.json");
  mkdirSync(runs, { recursive: true });
  let calls = 0;
  const count = () => { calls += 1; return monitor(); };
  // The injected clock and the stamped mtime agree, so generatedAt decides alone.
  for (const [age, expected] of [
    [-RESOURCES_TTL_MS, false], [RESOURCES_TTL_MS - 1, false],
    [-RESOURCES_TTL_MS - 1, true], [RESOURCES_TTL_MS + 1, true],
  ] as const) {
    writeFileSync(file, JSON.stringify({ generatedAt: new Date(NOW + age).toISOString(), lanes: {} }));
    utimesSync(file, new Date(NOW + age), new Date(NOW + age));
    expect(json(fleetResourcesCall({}, runs, NOW, count)).refreshed).toBe(expected);
  }
  expect(calls).toBe(2);
});

test("ensureFleetResources creates a missing runs root and never re-runs inside the TTL", () => {
  const runs = join(home, ".ashlr-runs"), file = join(runs, "resources.json");
  let calls = 0;
  const count = () => { calls += 1; return monitor(); };
  const first = ensureFleetResources(runs, 6, Date.now(), count);
  expect(first).toMatchObject({ refreshed: true, ledger: { sources: { monitor: "ok", slots: "missing", jobs: "missing" } } });
  expect(Object.keys(first.ledger.lanes)).toEqual(SIX_LANES);
  expect(ensureFleetResources(runs, 6, Date.now(), count).refreshed).toBe(false);
  utimesSync(file, new Date(Date.now() - RESOURCES_TTL_MS - 1000), new Date(Date.now() - RESOURCES_TTL_MS - 1000));
  expect(ensureFleetResources(runs, 6, Date.now(), count).refreshed).toBe(true);
  expect(calls).toBe(2);
});

test("registered handler is in the catalog and rejects arguments and paths", async () => {
  const catalog = await Bun.file(join(import.meta.dir, "../servers/_tool-catalog.json")).json();
  const tool = getTool("ashlr__fleet_resources")!;
  expect(tool).toBeTruthy();
  expect(catalog.find((entry: { name: string }) => entry.name === "ashlr__fleet_resources"))
    .toMatchObject({ module: "./fleet-resources-server-handlers", inputSchema: tool.inputSchema });
  for (const args of [null, [], "x", { root: "/" }, { hours: 6 }, { since: "x" }]) {
    const failed = await tool.handler(args as Record<string, unknown>, { env: {} });
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content[0]!.text)).toEqual({ error: "invalid fleet resources arguments" });
  }
});

test("default root: two handler calls write ~/.ashlr-runs/resources.json and re-run once per minute", () => {
  const runs = join(home, ".ashlr-runs"), bin = join(home, "bin"), count = join(home, "monitor-count");
  seedRuns(runs);
  mkdirSync(bin);
  const stub = join(bin, "ashlr");
  writeFileSync(stub, `#!/bin/sh\necho x >> '${count}'\nprintf '%s' '${monitor()}'\n`);
  chmodSync(stub, 0o755);
  const child = Bun.spawnSync([process.execPath, "-e", `
    await import('./servers/fleet-resources-server-handlers.ts');
    const { getTool } = await import('./servers/_tool-base.ts');
    const handler = getTool('ashlr__fleet_resources').handler;
    console.log(JSON.stringify([await handler({}, { env: {} }), await handler({}, { env: {} })]));
  `], { cwd: join(import.meta.dir, ".."), env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toBe("");
  const [first, second] = (JSON.parse(child.stdout.toString()) as ToolResult[]).map(result => json(result));
  expect(first.refreshed).toBe(true);
  expect(second.refreshed).toBe(false);
  expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1); // one monitor run for two calls
  const written = JSON.parse(readFileSync(join(runs, "resources.json"), "utf8"));
  expect(Object.keys(written.lanes)).toEqual([...SIX_LANES, "devin"].sort());
  expect(written.lanes.claude.jobsPerHour).toBeGreaterThan(0);
  expect(written.lanes.claude.tokensPerHour).toBeGreaterThan(0);
  expect(written.lanes.devin.slotsRunning).toBe(1);
  expect(first.lanes.claude.availability).toBe("open");
}, timingBudgetMs(15_000));

test("UI serves the same ledger refresh on /api/resources", async () => {
  const runs = join(home, ".ashlr-runs");
  seedRuns(runs);
  let calls = 0;
  const server = startFleetUi({ root: join(home, ".ashlr"), port: 0, monitor: () => { calls += 1; return monitor(); } });
  try {
    const get = () => fetch(`http://127.0.0.1:${server.port}/api/resources`);
    const first = await (await get()).json();
    expect(first.refreshed).toBe(true);
    expect(calls).toBe(1);
    expect(Object.keys(first.lanes)).toEqual([...SIX_LANES, "devin"].sort());
    expect(first.lanes.claude.jobsPerHour).toBeGreaterThan(0);
    expect(first.lanes.devin.slotsRunning).toBe(1);
    const file = JSON.parse(readFileSync(join(runs, "resources.json"), "utf8"));
    expect(file.generatedAt).toBe(first.generatedAt);
    const second = await (await get()).json();
    expect(second.refreshed).toBe(false);   // the UI reuses a fresh ledger too
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(calls).toBe(1);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/resources`, { method: "POST" })).status).toBe(405);
  } finally { await server.stop(true); }
});
