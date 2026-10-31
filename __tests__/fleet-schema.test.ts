import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFleetSchema, FLEET_SCHEMA_VERSION } from "../servers/_fleet-source";
import { fleetState } from "../servers/fleet-state-server-handlers";
import { getTool, listTools } from "../servers/_tool-base";
import catalog from "../servers/_tool-catalog.json" with { type: "json" };

const root = join(import.meta.dir, "..");
const docPath = join(root, "docs/fleet-schema.md");
const doc = readFileSync(docPath, "utf8");

let home: string, fleet: string, runs: string;
let warnings: string[];
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "fleet-schema-")));
  fleet = join(home, ".ashlr", "fleet");
  runs = join(home, ".ashlr-runs");
  warnings = [];
  mkdirSync(join(runs, "queue"), { recursive: true });
  mkdirSync(join(runs, "metrics"), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const warn = (message: string) => { warnings.push(message); };
const runsWrite = (name: string, text: string) => writeFileSync(join(runs, name), text);
const fleetWrite = (name: string, text: string) => {
  mkdirSync(fleet, { recursive: true });
  writeFileSync(join(fleet, name), text);
};
const state = () => fleetState(fleet, runs, { warn });

describe("docs/fleet-schema.md", () => {
  test("exists and pins every ~/.ashlr-runs file the plugin reads", () => {
    expect(existsSync(docPath)).toBe(true);
    for (const name of ["jobs.jsonl", "dispatch-events.log", "slots.json", "ready.tsv", "status.json"])
      expect(doc).toContain(name);
    expect(doc).toContain("schema_version");
    // Doc and code pin the same reader contract.
    expect(doc).toContain("FLEET_SCHEMA_VERSION");
    expect(FLEET_SCHEMA_VERSION).toBe(1);
  });
});

describe("checkFleetSchema", () => {
  test("warns once per file across records and repeated calls", () => {
    const file = join(home, "jobs.jsonl");
    checkFleetSchema(file, [{ schema_version: 2 }, { schema_version: 3 }, {}], warn);
    checkFleetSchema(file, { schema_version: 9 }, warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("jobs.jsonl");
    expect(warnings[0]).toContain(String(FLEET_SCHEMA_VERSION));
  });

  test("unversioned and pinned-version records never warn", () => {
    checkFleetSchema(join(home, "a.jsonl"), [{ job_id: "RQ-1" }, { schema_version: FLEET_SCHEMA_VERSION }], warn);
    checkFleetSchema(join(home, "b.json"), { dev: 2 }, warn);
    expect(warnings).toHaveLength(0);
  });

  test("distinct files warn independently; non-object records are skipped", () => {
    checkFleetSchema(join(home, "x.jsonl"), { schema_version: 2 }, warn);
    checkFleetSchema(join(home, "y.jsonl"), [null, "text", 5, { schema_version: "v2" }], warn);
    expect(warnings).toHaveLength(2);
    expect(warnings.filter(m => m.includes("x.jsonl"))).toHaveLength(1);
    expect(warnings.filter(m => m.includes("y.jsonl"))).toHaveLength(1);
  });

  test("a throwing warn sink cannot crash the read", () => {
    expect(() => checkFleetSchema(join(home, "z.jsonl"), { schema_version: 7 }, () => { throw new Error("sink"); })).not.toThrow();
  });

  test("the default sink writes one stderr line per mismatched file", () => {
    const real = process.stderr.write;
    const captured: string[] = [];
    process.stderr.write = ((chunk: unknown) => { captured.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { checkFleetSchema(join(home, "stderr.jsonl"), { schema_version: 2 }); }
    finally { process.stderr.write = real; }
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("schema_version 2");
    expect(captured[0]).toContain("stderr.jsonl");
  });
});

describe("fleet-state reads", () => {
  test("fleet path: one warning per mismatched file, deduped across calls", () => {
    fleetWrite("jobs.jsonl",
      '{"job_id":"RQ-1","schema_version":2,"state":"done"}\n{"job_id":"RQ-2","schema_version":3,"state":"running"}\n');
    fleetWrite("leader-events.jsonl", '{"event":"hold","schema_version":5}\n');
    const first = state();
    expect(first.jobs).toHaveLength(2);
    expect(first.leader_event).toMatchObject({ event: "hold" });
    expect(warnings).toHaveLength(2);
    expect(warnings.filter(m => m.includes("jobs.jsonl"))).toHaveLength(1);
    expect(warnings.filter(m => m.includes("leader-events.jsonl"))).toHaveLength(1);
    state();
    expect(warnings).toHaveLength(2); // process-lifetime dedup: still one per file
  });

  test("map files: schema_version is warned on and stripped, never a lane", () => {
    fleetWrite("targets.json", '{"schema_version":2,"codex-personal":3}');
    fleetWrite("holds.json", '{"schema_version":4,"claude-max":"quota"}');
    const result = state();
    expect(warnings).toHaveLength(2);
    expect(warnings.filter(m => m.includes("targets.json"))).toHaveLength(1);
    expect(warnings.filter(m => m.includes("holds.json"))).toHaveLength(1);
    expect(result.targets).toEqual({ "codex-personal": 3 });
    expect(result.holds).toEqual({ "claude-max": "quota" });
  });

  test("runs fallback: mismatched slots, jobs and dispatch files warn once each", () => {
    runsWrite("queue/slots.json", '{"schema_version":2,"dev":2,"ops":1}');
    runsWrite("metrics/jobs.jsonl",
      '{"job_id":"RQ-1","schema_version":2,"state":"done"}\n{"job_id":"RQ-2","schema_version":9,"state":"running"}\n');
    runsWrite("queue/dispatch-events.log", '{"type":"leader","schema_version":7,"ts":"2026-10-30T12:00:00Z"}\n');
    const result = state();
    expect(warnings).toHaveLength(3);
    expect(warnings.filter(m => m.includes("slots.json"))).toHaveLength(1);
    expect(warnings.filter(m => m.includes("metrics/jobs.jsonl"))).toHaveLength(1);
    expect(warnings.filter(m => m.includes("dispatch-events.log"))).toHaveLength(1);
    expect(result.targets).toEqual({ dev: 2, ops: 1 }); // envelope key is not a lane
    expect(result.jobs).toHaveLength(2);
    state();
    expect(warnings).toHaveLength(3);
  });

  test("current unversioned files produce no warnings on either path", () => {
    runsWrite("queue/slots.json", '{"dev":2,"ops":1}');
    runsWrite("metrics/jobs.jsonl", '{"job_id":"RQ-1","pool":"dev","state":"done"}\n');
    runsWrite("queue/dispatch-events.log", '[2026-10-30T11:00:00Z] dispatched job=RQ-1\n');
    runsWrite("HOLD", "quota pause\n");
    state();
    fleetWrite("targets.json", '{"codex-personal":2}');
    fleetWrite("jobs.jsonl", '{"id":"RQ-9","state":"done"}\n');
    state();
    expect(warnings).toHaveLength(0);
  });

  test("records at the pinned version read cleanly and warn nothing", () => {
    runsWrite("queue/slots.json", '{"schema_version":1,"dev":2}');
    runsWrite("metrics/jobs.jsonl", '{"job_id":"RQ-1","schema_version":1,"state":"done"}\n');
    const result = state();
    expect(warnings).toHaveLength(0);
    expect(result.targets).toEqual({ dev: 2 });
    expect(result.jobs).toEqual([{ job_id: "RQ-1", schema_version: 1, state: "done" }]);
  });

  test("a HOLD object's schema_version strips out without claiming a lane hold", () => {
    runsWrite("queue/slots.json", '{"dev":2}');
    runsWrite("HOLD", '{"dev":"quota","schema_version":2}');
    const result = state();
    expect(result.holds).toEqual({ dev: "quota" });
  });

  test("the MCP handler warns to stderr once per mismatched file, with stdout clean", () => {
    runsWrite("queue/slots.json", '{"schema_version":2,"dev":2}');
    runsWrite("metrics/jobs.jsonl",
      '{"job_id":"RQ-1","schema_version":2,"state":"done"}\n{"job_id":"RQ-2","schema_version":2,"state":"running"}\n');
    const proc = Bun.spawnSync([process.execPath, "-e", `
      await import("./servers/fleet-state-server-handlers.ts");
      const { getTool } = await import("./servers/_tool-base.ts");
      const result = await getTool("ashlr__fleet_state").handler({}, { env: {} });
      console.log(result.content[0].text);
    `], { cwd: join(import.meta.dir, ".."), env: { HOME: home, PATH: "/usr/bin:/bin" } });
    expect(proc.exitCode).toBe(0);
    const stderr = proc.stderr.toString();
    expect(stderr.split("schema_version").length - 1).toBe(2); // one warning each for slots.json and jobs.jsonl
    expect(stderr).toContain("slots.json");
    expect(stderr).toContain("metrics/jobs.jsonl");
    const result = JSON.parse(proc.stdout.toString());
    expect(result.targets).toEqual({ dev: 2 });
    expect(result.jobs).toHaveLength(2);
  });
});

describe("tool catalog", () => {
  test("no new tool: the schema check is read-path machinery, not an MCP surface", () => {
    expect(getTool("ashlr__fleet_state")).toBeDefined();
    expect(getTool("ashlr__fleet_schema")).toBeUndefined();
    expect(listTools().every(tool => !/schema/i.test(tool.name))).toBe(true);
    expect(catalog.every((tool: { name: string }) => !/schema/i.test(tool.name))).toBe(true);
  });
});
