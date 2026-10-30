import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../servers/fleet-steer-server-handlers";
import { getTool, type ToolResult } from "../servers/_tool-base";
import { fleetSteer } from "../scripts/fleet-steer";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const sources = { "targets.json": '{"dev":2}', "holds.json": '{"dev":"paused"}',
  "jobs.jsonl": '{"job_id":"RQ-1","pool":"ops"}\n', "slots.json": '{"dev":2}', "leader-events.jsonl": "" };
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "fleet-steer-mcp-")));
  homes.push(home);
  const root = join(home, ".ashlr", "fleet");
  mkdirSync(root, { recursive: true });
  for (const [file, contents] of Object.entries(sources)) writeFileSync(join(root, file), contents);
  return { home, root };
}
type Call = ["lanes" | "proposals" | "propose", unknown];
function run(home: string, calls: Call[]): ToolResult[] {
  // Fresh process exercises the production lazy catalog with an isolated HOME.
  const child = Bun.spawnSync([process.execPath, "-e", `
    const { registerLazyTools } = await import('./servers/_lazy-tools.ts');
    const { getTool } = await import('./servers/_tool-base.ts');
    registerLazyTools();
    const results = [];
    for (const [command, args] of ${JSON.stringify(calls)})
      results.push(await getTool('ashlr__fleet_' + command).handler(args, { env: {} }));
    console.log(JSON.stringify(results));
  `], { cwd: join(import.meta.dir, ".."), env: { HOME: home, PATH: "/usr/bin:/bin" } });
  expect(child.exitCode).toBe(0);
  return JSON.parse(child.stdout.toString());
}
const json = (result: ToolResult) => JSON.parse(result.content[0]!.text);
const move = { action: "reassign", job_id: "RQ-1", lane: "dev", author: "router", reason: "rebalance" };
const slots = { action: "set-slots", lane: "dev", slots: 3, author: "router", reason: "capacity" };
const unchanged = (root: string) => {
  for (const [file, contents] of Object.entries(sources)) expect(readFileSync(join(root, file), "utf8")).toBe(contents);
};

test("all three lazy MCP tools share CLI JSON and only append proposals", () => {
  const { home, root } = fixture();
  const reads = run(home, [["lanes", {}], ["proposals", {}]]);
  expect(reads.every(result => !result.isError)).toBe(true);
  expect(json(reads[0]!)).toEqual(fleetSteer(["lanes"], new Date(), root));
  expect(json(reads[1]!)).toMatchObject({ command: "proposals", proposals: [], skipped: 0 });
  expect(existsSync(join(root, "steer-proposals.jsonl"))).toBe(false);
  const results = run(home, [["propose", move], ["propose", slots], ["proposals", {}], ["propose", move]]);
  expect(results.slice(0, 3).every(result => !result.isError)).toBe(true);
  expect(json(results[0]!).proposal).toMatchObject({ ...move, status: "proposed", observed: { target: 2, hold: "paused", job_lane: "ops" } });
  expect(json(results[1]!).proposal).toMatchObject({ ...slots, status: "proposed" });
  expect(json(results[2]!).proposals).toEqual(results.slice(0, 2).map(result => json(result).proposal));
  expect(results[3]!.isError).toBe(true);
  expect(json(results[3]!)).toEqual({ error: "duplicate proposal" });
  expect(readFileSync(join(root, "steer-proposals.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  unchanged(root);
});

test("MCP refuses invalid lane and job identifiers before creating a journal", () => {
  const { home, root } = fixture();
  const calls: Call[] = [];
  for (const id of ["../escape", "a/b", "a\\b", "with space", "", "-lead", ".dot", "x".repeat(129), "x\ny", "x\u0000", null, 1, {}]) {
    calls.push(["propose", { ...move, lane: id }], ["propose", { ...slots, lane: id }], ["propose", { ...move, job_id: id }]);
  }
  for (const result of run(home, calls)) {
    expect(result.isError).toBe(true);
    expect(json(result).error).toStartWith("invalid fleet steer");
  }
  expect(existsSync(join(root, "steer-proposals.jsonl"))).toBe(false);
  unchanged(root);
});

test("MCP rejects path overrides, execution flags, malformed inputs and action fields", () => {
  const { home, root } = fixture();
  const calls: Call[] = [null, [], "x", { root }, { output: "slots.json" }].flatMap(args =>
    (["lanes", "proposals", "propose"] as const).map(command => [command, args] as Call));
  for (const args of [{ ...move, root }, { ...move, output: "slots.json" }, { ...move, apply: true },
    { ...move, action: "kill" }, { ...move, slots: 2 }, { ...slots, job_id: "RQ-1" }, { ...move, job_id: undefined },
    { ...move, author: "a\nb" }, { ...move, author: "a".repeat(201) }, { ...move, reason: " " },
    { ...move, reason: "r".repeat(513) }, ...[-1, 1025, 1.5, "3", null, true].map(value => ({ ...slots, slots: value }))]) {
    calls.push(["propose", args]);
  }
  for (const result of run(home, calls)) { expect(result.isError).toBe(true); expect(json(result).error).toStartWith("invalid fleet steer"); }
  expect(existsSync(join(root, "steer-proposals.jsonl"))).toBe(false);
  unchanged(root);
});

test("unsafe journals return JSON errors without exposing paths or changing targets", () => {
  for (const link of [symlinkSync, linkSync]) {
    const { home, root } = fixture();
    link(join(root, "slots.json"), join(root, "steer-proposals.jsonl"));
    for (const result of run(home, [["proposals", {}], ["propose", move]])) {
      expect(result.isError).toBe(true);
      expect(json(result)).toEqual({ error: "fleet steer unavailable" });
    }
    unchanged(root);
  }
});

test("catalog schemas match all three registered steering tools", async () => {
  const catalog = await Bun.file(join(import.meta.dir, "../servers/_tool-catalog.json")).json();
  for (const command of ["lanes", "proposals", "propose"]) {
    const tool = getTool(`ashlr__fleet_${command}`)!;
    expect(tool).toBeTruthy();
    expect(catalog.find((entry: { name: string }) => entry.name === tool.name)).toMatchObject({
      inputSchema: tool.inputSchema, module: "./fleet-steer-server-handlers",
    });
  }
});
