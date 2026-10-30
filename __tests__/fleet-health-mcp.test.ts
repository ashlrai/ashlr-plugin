import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetDirtyTriageCall, fleetGhostsCall } from "../servers/fleet-health-server-handlers";
import { getTool, type ToolResult } from "../servers/_tool-base";
import type { DirtyPull } from "../scripts/fleet-dirty-triage";

const roots: string[] = [];
const fixture = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-health-"))); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const now = () => Date.parse("2026-10-30T12:00:00Z");
const json = (result: ToolResult) => { expect(result.isError).toBeUndefined(); return JSON.parse(result.content[0]!.text); };
const ghostDeps = { procs: () => [], alive: () => false, now };

test("ghost MCP JSON distinguishes live, stalled and archived ghost slots without reading logs", async () => {
  const root = fixture(), lane = join(root, "dev"); mkdirSync(lane);
  mkdirSync(join(lane, "ghost.base"));
  for (const name of ["ghost.log.gz", "stalled.log", "live.log"]) writeFileSync(join(lane, name), "fixture-private-log-body");
  writeFileSync(join(lane, "live.pid"), "123\n");
  const report = json(await fleetGhostsCall({}, root, { ...ghostDeps, alive: pid => pid === 123 }));
  expect(report).toMatchObject({ schema_version: 1, live_known: true, errors: {},
    counts: { lanes: 1, reported: 2, live: 1, live_unknown: 0, stalled: 1, ghosts: 1 } });
  expect(report.lanes[0]).toMatchObject({ lane: "dev", ghosts: ["ghost"], stalled: ["stalled"] });
  expect(JSON.stringify(report)).not.toContain("fixture-private-log-body");
  expect(readFileSync(join(lane, "stalled.log"), "utf8")).toBe("fixture-private-log-body");
  const unknown = json(await fleetGhostsCall({}, root, { ...ghostDeps, procs: () => { throw new Error("private error"); } }));
  expect(unknown).toMatchObject({ live_known: false, errors: { processes: "unavailable" }, counts: { live_unknown: 2, ghosts: 0, stalled: 0 } });
});

test("empty ghost fixture succeeds while a missing source is a JSON tool error", async () => {
  const root = fixture();
  expect(json(await fleetGhostsCall({}, root, ghostDeps))).toMatchObject({ lanes: [], counts: { lanes: 0, ghosts: 0 } });
  const missing = await fleetGhostsCall({}, join(root, "private-missing"), ghostDeps);
  expect(missing.isError).toBe(true);
  expect(JSON.parse(missing.content[0]!.text)).toEqual({ error: "fleet ghosts unavailable" });
});

test("registered ghosts handler reads the fixed HOME runs directory with empty input", () => {
  const home = fixture(); mkdirSync(join(home, ".ashlr", "fleet", "runs"), { recursive: true });
  const child = Bun.spawnSync([process.execPath, "-e", `
    await import('./servers/fleet-health-server-handlers.ts');
    const { getTool } = await import('./servers/_tool-base.ts');
    console.log(JSON.stringify(await getTool('ashlr__fleet_ghosts').handler({}, { env: {} })));
  `], { cwd: join(import.meta.dir, ".."), env: { HOME: home, PATH: "/usr/bin:/bin" } });
  expect(child.exitCode).toBe(0);
  expect(json(JSON.parse(child.stdout.toString()))).toMatchObject({ runs: join(home, ".ashlr", "fleet", "runs"), lanes: [] });
}, 20_000);

test("dirty MCP ranks fixture PRs, forwards typed options and uses only read queries", async () => {
  const calls: string[][] = [];
  const prs = [1, 2, 3].map(number => ({ number, title: `PR ${number}`, state: "OPEN", mergeStateStatus: number === 3 ? "CLEAN" : "DIRTY",
    headRepository: {}, headRefOid: String(number).repeat(40), baseRefName: "main", updatedAt: new Date(now()).toISOString() } as DirtyPull));
  const report = json(await fleetDirtyTriageCall({ repos: ["ashlrai/ashlr-plugin"], staleDays: 7 }, { now, gh: async args => {
    calls.push(args);
    return JSON.stringify(args[0] === "pr" ? prs : args.at(-1)!.includes("/compare/") ? { status: "diverged", ahead_by: 1, behind_by: 2 } : []);
  } }));
  expect(report).toMatchObject({ staleDays: 7, truncated: false, counts: { "recut-worthy": 2, superseded: 0, stale: 0, errors: 0 } });
  expect(report.repos[0].prs.map((pr: { number: number; reason: string }) => [pr.number, pr.reason])).toEqual([[1, "C6"], [2, "C6"]]);
  expect(calls[0]!.slice(0, 4)).toEqual(["pr", "list", "--repo", "ashlrai/ashlr-plugin"]);
  for (const args of calls.slice(1)) { expect(args[0]).toBe("api"); expect(args).not.toContain("--method"); expect(args).not.toContain("--field"); }
});

test("empty dirty input discovers the current repo; failures redact command output", async () => {
  const calls: string[][] = [];
  const report = json(await fleetDirtyTriageCall({}, { now, gh: async args => { calls.push(args); return JSON.stringify(args[0] === "api" ? { full_name: "ashlrai/ashlr-plugin" } : []); } }));
  expect(report).toMatchObject({ staleDays: 14, counts: { "recut-worthy": 0, superseded: 0, stale: 0, errors: 0 }, repos: [{ repo: "ashlrai/ashlr-plugin", prs: [] }] });
  expect(calls[0]).toEqual(["api", "repos/{owner}/{repo}"]);
  expect(calls[1]).not.toContain("--repo");
  const failed = await fleetDirtyTriageCall({}, { now, gh: async () => { throw new Error("fixture-private-command-output"); } });
  expect(failed.isError).toBe(true);
  expect(JSON.parse(failed.content[0]!.text)).toEqual({ error: "fleet dirty triage unavailable; requires a pinned Locus identity" });
});

test("both registered tools match the catalog and reject malformed input before reading", async () => {
  const catalog = await Bun.file(join(import.meta.dir, "../servers/_tool-catalog.json")).json();
  for (const name of ["ashlr__fleet_ghosts", "ashlr__fleet_dirty_triage"]) {
    const tool = getTool(name)!;
    expect(catalog.find((entry: { name: string }) => entry.name === name)).toMatchObject({ module: "./fleet-health-server-handlers", inputSchema: tool.inputSchema });
    for (const args of [{ root: "/" }, { argv: [] }]) expect((await tool.handler(args, { env: {} })).isError).toBe(true);
  }
  for (const args of [null, [], "", { repos: null }, { repos: ["../etc"] }, { repos: ["a/b", "a/b"] }, { repos: Array(21).fill("a/b") }, { staleDays: null }, { staleDays: "14" }, { staleDays: 0 }, { staleDays: 366 }, { staleDays: 1.5 }]) {
    const failed = await fleetDirtyTriageCall(args, { now, gh: async () => { throw new Error("must not query"); } });
    expect(JSON.parse(failed.content[0]!.text)).toEqual({ error: "invalid fleet health arguments" });
    expect(failed.isError).toBe(true);
  }
  for (const args of [null, [], { runsDir: "/" }]) expect((await fleetGhostsCall(args, fixture(), ghostDeps)).isError).toBe(true);
});
