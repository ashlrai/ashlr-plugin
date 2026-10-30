import { afterEach, expect, test } from "bun:test";
import { timingBudgetMs } from "../scripts/timing-budget";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetDirectionCall, fleetSnapshotCall } from "../servers/fleet-snapshot-server-handlers";
import { getTool } from "../servers/_tool-base";

const roots: string[] = [];
const fixture = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-snap-mcp-"))); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fleet() {
  const root = fixture();
  writeFileSync(join(root, "targets.json"), '{"dev":{"slots":2}}');
  writeFileSync(join(root, "holds.json"), "{}");
  writeFileSync(join(root, "jobs.jsonl"), '{"id":"RQ-1","pool":"dev","state":"queued","pr_url":"https://example.test/pr/1"}\n');
  writeFileSync(join(root, "leader-events.jsonl"), '{"event":"idle"}\n');
  return root;
}
function project() {
  const root = fixture();
  for (const file of ["VISION.md", "MASON-INBOX.md"]) writeFileSync(join(root, file), `original ${file}\n`);
  return root;
}
const NOW = new Date("2026-10-30T12:00:00Z");
const proposal = { command: "propose", author: "Mason", text: "Consider this\nnext step" };

test("fleet_snapshot returns every collection then only cursor deltas", () => {
  const root = fleet();
  const first = fleetSnapshotCall({}, root);
  expect(first).toMatchObject({ schema_version: 1, lanes: { dev: { target: { slots: 2 }, hold: null } },
    jobs: { "RQ-1": { state: "queued" } }, prs: { "RQ-1": { url: "https://example.test/pr/1" } },
    leader: { event: "idle" }, errors: {}, removed: {} });
  expect(fleetSnapshotCall({ cursor: first.cursor }, root)).toEqual({ schema_version: 1, cursor: first.cursor, removed: {} });
  writeFileSync(join(root, "jobs.jsonl"), '{"id":"RQ-1","pool":"dev","state":"done"}\n');
  expect(fleetSnapshotCall({ cursor: first.cursor }, root)).toMatchObject({ jobs: { "RQ-1": { state: "done" } }, removed: { prs: ["RQ-1"] } });
});

test("fleet_snapshot rejects malformed arguments and cursors before reading", () => {
  const root = fleet();
  for (const args of [null, [], "x", { since: "x" }, { root }, { cursor: 1 }, { cursor: null }, { cursor: "{}", extra: 1 }]) {
    expect(() => fleetSnapshotCall(args, root)).toThrow("invalid fleet snapshot");
  }
  for (const cursor of ["bad", "{}", "null", JSON.stringify({ version: 2 })]) {
    expect(() => fleetSnapshotCall({ cursor }, root)).toThrow("invalid snapshot cursor");
  }
});

test("fleet_direction read returns project markdown and refuses other files", () => {
  const root = project();
  expect(fleetDirectionCall({ command: "read" }, root, NOW)).toMatchObject({ command: "read", source: join(root, "VISION.md"), direction: "original VISION.md\n" });
  writeFileSync(join(root, "ROADMAP.md"), "Next quarter\n");
  expect(fleetDirectionCall({ command: "read", direction: "ROADMAP.md" }, root, NOW)).toMatchObject({ direction: "Next quarter\n" });
  expect(fleetDirectionCall({ command: "read", direction: "MASON-INBOX.md" }, root, NOW)).toMatchObject({ direction: "original MASON-INBOX.md\n" });
  expect(existsSync(join(root, "DIRECTION-PROPOSED.md"))).toBe(false);
  for (const direction of [".env", ".notes.md", "secrets.json", "../VISION.md", "nested/VISION.md", "/VISION.md", "VISION", "DIRECTION-PROPOSED.md", "direction-proposed.md"]) {
    expect(() => fleetDirectionCall({ command: "read", direction }, root, NOW), direction).toThrow();
  }
  expect(() => fleetDirectionCall({ command: "read" }, fixture(), NOW)).toThrow();
});

test("fleet_direction propose appends labelled suggestions and leaves protected files unchanged", () => {
  const root = project(), output = join(root, "DIRECTION-PROPOSED.md");
  expect(fleetDirectionCall(proposal, root, NOW)).toMatchObject({ command: "propose", status: "proposed", author: "Mason", date: "2026-10-30T12:00:00.000Z" });
  const entry = readFileSync(output, "utf8");
  expect(entry).toContain('2026-10-30T12:00:00.000Z — "Mason"');
  expect(entry).toContain("> Consider this\n> next step");
  fleetDirectionCall(proposal, root, NOW);
  expect(readFileSync(output, "utf8")).toBe(entry + entry);
  for (const file of ["VISION.md", "MASON-INBOX.md"]) expect(readFileSync(join(root, file), "utf8")).toBe(`original ${file}\n`);
});

test("proposals refuse MASON-INBOX.md and VISION.md through every argument", () => {
  const root = project();
  for (const args of [
    { ...proposal, output: "MASON-INBOX.md" }, { ...proposal, output: "VISION.md" },
    { ...proposal, direction: "MASON-INBOX.md" }, { ...proposal, direction: "VISION.md" },
    { ...proposal, "--output": "VISION.md" }, { ...proposal, root }, { ...proposal, "--root": "/" },
    { command: "propose", author: "Mason" }, { command: "propose", text: "x" },
    { command: "oops", author: "Mason", text: "x" },
    { ...proposal, author: "bad\nauthor" }, { ...proposal, author: " " }, { ...proposal, author: "a".repeat(201) },
    { ...proposal, text: " " }, { ...proposal, text: "x".repeat(8193) },
  ]) expect(() => fleetDirectionCall(args, root, NOW)).toThrow();
  expect(existsSync(join(root, "DIRECTION-PROPOSED.md"))).toBe(false);
  for (const file of ["VISION.md", "MASON-INBOX.md"]) expect(readFileSync(join(root, file), "utf8")).toBe(`original ${file}\n`);
});

test("proposal destination refuses link aliases to protected files", () => {
  for (const file of ["VISION.md", "MASON-INBOX.md"]) {
    for (const link of [symlinkSync, linkSync]) {
      const root = project();
      link(join(root, file), join(root, "DIRECTION-PROPOSED.md"));
      expect(() => fleetDirectionCall(proposal, root, NOW)).toThrow();
      expect(readFileSync(join(root, file), "utf8")).toBe(`original ${file}\n`);
    }
  }
});

test("MCP catalog registers both tools and handlers validate without touching disk", async () => {
  const catalog = await Bun.file(join(import.meta.dir, "../servers/_tool-catalog.json")).json();
  for (const name of ["ashlr__fleet_snapshot", "ashlr__fleet_direction"]) {
    const tool = getTool(name)!;
    expect(tool, name).toBeTruthy();
    expect(catalog.find((entry: { name: string }) => entry.name === name)).toMatchObject({ inputSchema: tool.inputSchema, module: "./fleet-snapshot-server-handlers" });
  }
  const snapshot = getTool("ashlr__fleet_snapshot")!.handler;
  for (const args of [{ cursor: 1 }, { root: "/" }, { since: "x" }]) {
    expect((await snapshot(args, { env: {} })).isError).toBe(true);
  }
  const direction = getTool("ashlr__fleet_direction")!.handler;
  for (const args of [{ command: "oops" }, { command: 1 }, { command: "read", direction: "/etc/passwd" },
    { command: "propose", author: "a", text: "t", output: "VISION.md" }]) {
    expect((await direction(args, { env: {} })).isError).toBe(true);
  }
  const refused = await direction({ command: "read", direction: "DIRECTION-PROPOSED.md" }, { env: {} });
  expect(refused.isError).toBe(true);
  expect(refused.content[0]!.text).toContain("MASON-INBOX.md and VISION.md are protected");
});

test("spawned handlers read the fixed HOME fleet dir and write the launch project", () => {
  const home = fixture(), work = project();
  mkdirSyncHomeFleet(home);
  const snapshot = Bun.spawnSync([process.execPath, "-e", `
    await import('./servers/fleet-snapshot-server-handlers.ts');
    const { getTool } = await import('./servers/_tool-base.ts');
    console.log(JSON.stringify(await getTool('ashlr__fleet_snapshot').handler({}, { env: {} })));
  `], { cwd: join(import.meta.dir, ".."), env: { HOME: home, PATH: "/usr/bin:/bin" } });
  expect(snapshot.exitCode).toBe(0);
  const view = JSON.parse(snapshot.stdout.toString());
  expect(view.isError).toBeUndefined();
  expect(JSON.parse(view.content[0].text)).toMatchObject({ schema_version: 1, jobs: { "RQ-9": { state: "queued" } }, errors: {} });

  const servers = join(import.meta.dir, "../servers");
  const run = (args: Record<string, unknown>) => Bun.spawnSync([process.execPath, "-e", `
    await import('${join(servers, "fleet-snapshot-server-handlers.ts")}');
    const { getTool } = await import('${join(servers, "_tool-base.ts")}');
    console.log(JSON.stringify(await getTool('ashlr__fleet_direction').handler(${JSON.stringify(args)}, { env: {} })));
  `], { cwd: work, env: { HOME: home, PATH: "/usr/bin:/bin" } });
  const read = run({ command: "read" });
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(JSON.parse(read.stdout.toString()).content[0].text)).toMatchObject({ direction: "original VISION.md\n" });
  const proposed = run(proposal);
  expect(proposed.exitCode).toBe(0);
  const output = JSON.parse(JSON.parse(proposed.stdout.toString()).content[0].text);
  expect(output).toMatchObject({ status: "proposed", output: join(work, "DIRECTION-PROPOSED.md") });
  expect(readFileSync(join(work, "DIRECTION-PROPOSED.md"), "utf8")).toContain("> Consider this");
  for (const file of ["VISION.md", "MASON-INBOX.md"]) expect(readFileSync(join(work, file), "utf8")).toBe(`original ${file}\n`);
  // Three sequential cold `bun -e` spawns take ~3.3s uncontended and have
  // crossed the default 5s budget under --parallel load; give this
  // subprocess-heavy test an explicit scaled timeout like pipe-server's.
}, timingBudgetMs(15_000));

function mkdirSyncHomeFleet(home: string) {
  const fleetRoot = join(home, ".ashlr", "fleet");
  mkdirSync(fleetRoot, { recursive: true });
  writeFileSync(join(fleetRoot, "targets.json"), "{}");
  writeFileSync(join(fleetRoot, "holds.json"), "{}");
  writeFileSync(join(fleetRoot, "jobs.jsonl"), '{"id":"RQ-9","pool":"dev","state":"queued"}\n');
  writeFileSync(join(fleetRoot, "leader-events.jsonl"), '{"event":"idle"}\n');
}
