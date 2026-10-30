import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync, mkdirSync, realpathSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetState } from "../servers/fleet-state-server-handlers";
import { getTool } from "../servers/_tool-base";

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-state-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const write = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value));

test("reads fixture files, returns last 20 jobs and latest appended event without writes", () => {
  write("targets.json", { "codex-personal": 2 });
  write("holds.json", { "claude-max": "quota" });
  const jobs = Array.from({ length: 25 }, (_, id) => ({ id, state: "done" }));
  const log = jobs.map(job => JSON.stringify(job)).join("\n") + "\n\n";
  writeFileSync(join(root, "jobs.jsonl"), log);
  writeFileSync(join(root, "leader-events.jsonl"), '{"event":"start"}\n{"event":"hold"}\n');
  expect(fleetState(root)).toEqual({
    targets: { "codex-personal": 2 }, holds: { "claude-max": "quota" },
    jobs: jobs.slice(5), leader_event: { event: "hold" }, errors: {},
  });
  expect(readFileSync(join(root, "jobs.jsonl"), "utf8")).toBe(log);
});

test("missing directory and files remain unknown rather than claiming an empty fleet", () => {
  for (const dir of [root, join(root, "missing")]) {
    const result = fleetState(dir);
    expect([result.targets, result.holds, result.jobs, result.leader_event]).toEqual([null, null, null, null]);
    expect(Object.values(result.errors)).toEqual(Array(4).fill("missing"));
  }
});

test("empty logs are valid; corrupt files fail independently without echoing contents", () => {
  writeFileSync(join(root, "jobs.jsonl"), "\n");
  writeFileSync(join(root, "leader-events.jsonl"), "\n");
  writeFileSync(join(root, "targets.json"), "not-json-sensitive-fixture");
  write("holds.json", []);
  expect(fleetState(root)).toEqual({ targets: null, holds: [], jobs: [], leader_event: null, errors: { "targets.json": "invalid" } });
});

test("rejects symlinks to environment files and symlinked directories", () => {
  writeFileSync(join(root, ".env"), "sensitive-fixture");
  symlinkSync(join(root, ".env"), join(root, "targets.json"));
  expect(fleetState(root).errors["targets.json"]).toBe("unsafe");
  mkdirSync(join(root, "real"));
  symlinkSync(join(root, "real"), join(root, "alias"));
  expect(Object.values(fleetState(join(root, "alias")).errors)).toEqual(Array(4).fill("unsafe"));
});

test("oversized and malformed logs are unavailable", () => {
  writeFileSync(join(root, "jobs.jsonl"), " ".repeat(4 * 1024 * 1024 + 1));
  writeFileSync(join(root, "leader-events.jsonl"), '{"event":"ok"}\nbroken');
  expect(fleetState(root).errors).toMatchObject({ "jobs.jsonl": "too_large", "leader-events.jsonl": "invalid" });
});

test("registered MCP tool rejects arbitrary file and environment arguments", async () => {
  const tool = getTool("ashlr__fleet_state")!;
  expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
  const result = await tool.handler({ path: join(root, ".env") }, { env: {} });
  expect(result.isError).toBe(true);
});

test("hard links cannot redirect reads to secret files", () => {
  writeFileSync(join(root, ".secret"), "sensitive-fixture");
  linkSync(join(root, ".secret"), join(root, "holds.json"));
  expect(fleetState(root).errors["holds.json"]).toBe("unsafe");
});

test("MCP invocation uses the fixed HOME layout and ignores unrelated environment files", () => {
  mkdirSync(join(root, ".ashlr", "fleet"), { recursive: true });
  writeFileSync(join(root, ".ashlr", "fleet", "targets.json"), '{"codex-personal":3}');
  writeFileSync(join(root, ".ashlr", "fleet", ".env"), "sensitive-fixture");
  const proc = Bun.spawnSync([process.execPath, "-e", `
    await import("./servers/fleet-state-server-handlers.ts");
    const { getTool } = await import("./servers/_tool-base.ts");
    const result = await getTool("ashlr__fleet_state").handler({}, { env: {} });
    console.log(result.content[0].text);
  `], { cwd: join(import.meta.dir, ".."), env: { HOME: root, PATH: "/usr/bin:/bin" } });
  expect(proc.exitCode).toBe(0);
  const result = JSON.parse(proc.stdout.toString());
  expect(result.targets).toEqual({ "codex-personal": 3 });
  expect(result.errors["holds.json"]).toBe("missing");
  expect(proc.stdout.toString()).not.toContain("sensitive-fixture");
});
