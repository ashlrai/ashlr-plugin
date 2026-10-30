import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetAct } from "../servers/fleet-actions-server-handlers";
import { getTool } from "../servers/_tool-base";

const roots: string[] = [];
const fixture = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-act-"))); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const audit = { requested_by: "router", reason: "operator request" };
const actions = [
  { action: "pause", lane: "codex-personal" }, { action: "resume", lane: "codex-personal" },
  { action: "kill", job_id: "RQ-123" }, { action: "reassign", job_id: "RQ-123", lane: "devin" },
  { action: "slots", lane: "codex-personal", slots: 0 }, { action: "steer", job_id: "RQ-123", message: "focus on tests\nthen report" },
];
for (const request of actions) test(`${request.action}: default preview and explicit pending request preserve audit`, () => {
  const root = fixture(), path = join(root, "actions.jsonl"), prefix = '{"legacy":true}\n';
  writeFileSync(path, prefix);
  writeFileSync(join(root, "jobs.jsonl"), "unchanged");
  const preview = fleetAct({ ...audit, ...request }, root);
  const pending = fleetAct({ ...audit, ...request, dry_run: false }, root);
  expect(preview).toMatchObject({ ...audit, ...request, status: "dry_run", dry_run: true });
  expect(pending).toMatchObject({ ...audit, ...request, status: "pending", dry_run: false });
  expect(preview.id).not.toBe(pending.id);
  expect(Number.isNaN(Date.parse(pending.requested_at))).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(prefix + JSON.stringify(preview) + "\n" + JSON.stringify(pending) + "\n");
  expect(readFileSync(join(root, "jobs.jsonl"), "utf8")).toBe("unchanged");
});
test("invalid input cannot create an audit or queue request", () => {
  const root = join(fixture(), "missing");
  for (const args of [null, [], {}, { action: "__proto__" }, ...actions.map(({ action }) => ({ ...audit, action })),
    { ...audit, ...actions[0], lane: "../escape" }, { ...audit, ...actions[0], dry_run: "false" },
    { ...audit, ...actions[0], reason: " " }, { ...audit, ...actions[0], root },
    { ...audit, ...actions[0], job_id: "extra" }, { ...audit, ...actions[5], message: "x".repeat(513) },
    ...[-1, 1025, 1.5, "2", NaN, Infinity].map(slots => ({ ...audit, ...actions[4], slots })),
  ]) expect(() => fleetAct(args, root)).toThrow("invalid fleet action");
  expect(existsSync(root)).toBe(false);
});
test("unsafe audit fails closed", () => {
  const root = fixture(), target = join(root, "target");
  writeFileSync(target, "unchanged");
  symlinkSync(target, join(root, "actions.jsonl"));
  expect(() => fleetAct({ ...audit, ...actions[2], dry_run: false }, root)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("unchanged");
});
test("MCP catalog and handler use the fixed HOME journal", async () => {
  const root = fixture(), tool = getTool("ashlr__fleet_act")!;
  const catalog = await Bun.file(join(import.meta.dir, "../servers/_tool-catalog.json")).json();
  expect(catalog.find((entry: { name: string }) => entry.name === tool.name)).toMatchObject({ inputSchema: tool.inputSchema, module: "./fleet-actions-server-handlers" });
  expect((await tool.handler({ ...audit, ...actions[0], root }, { env: {} })).isError).toBe(true);
  const proc = Bun.spawnSync([process.execPath, "-e", `
    await import('./servers/fleet-actions-server-handlers.ts');
    const { getTool } = await import('./servers/_tool-base.ts');
    console.log(JSON.stringify(await getTool('ashlr__fleet_act').handler(${JSON.stringify({ ...audit, ...actions[0] })}, { env: {} })));
  `], { cwd: join(import.meta.dir, ".."), env: { HOME: root, PATH: "/usr/bin:/bin" } });
  expect(proc.exitCode).toBe(0);
  const result = JSON.parse(proc.stdout.toString());
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.content[0].text)).toEqual(JSON.parse(readFileSync(join(root, ".ashlr/fleet/actions.jsonl"), "utf8")));
});
