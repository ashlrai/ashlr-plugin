import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetSurfaces } from "../scripts/fleet-surface";
import { startFleetUi } from "../scripts/fleet-ui-server";

const repo = join(import.meta.dir, "..");
const source = (file: string) => readFileSync(join(repo, "scripts/fleet-ui", file), "utf8");
function discover(html = source("index.html"), mobile = source("mobile-actions.js"), steer = source("steer-panel.js")) {
  // Read the actual button declarations, independently of the manifest's action lists.
  return [
    ...[...html.matchAll(/data-(fleet-action|steer)=["']([^"']+)["']/g)].map(([, kind, action]) => `${kind === "steer" ? "steer-panel" : "control-panel"}.js#${action}`),
    ...[...mobile.matchAll(/\bcontrol\([\s\S]*?,\s*['"]([^'"]+)['"]\s*,/g)].map(([, action]) => `mobile-actions.js#${action}`),
    ...[...steer.matchAll(/el\(['"]([^'"]+)['"]\)\.onclick\s*=/g)].map(([, action]) => `steer-panel.js#${action}`),
  ].map(entry => "scripts/fleet-ui/" + entry);
}
function checkParity(entries = fleetSurfaces, controls = discover()) {
  expect(controls.length).toBeGreaterThan(0);
  expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
  expect(entries.flatMap(entry => entry.ui).sort()).toEqual(controls.sort());
  for (const entry of entries) {
    expect(entry.http?.method).toMatch(/^(GET|POST)$/);
    expect(entry.http?.path).toMatch(/^\/api\//);
    expect(entry.cli?.[0]).toBe("bun");
    expect(entry.cli?.[1]).toMatch(/^scripts\/fleet-[\w-]+\.ts$/);
  }
}
test("every UI action has an HTTP and CLI surface, including proposal refresh", () => checkParity());
test("parity guard rejects new controls, missing entries, and missing agent surfaces", () => {
  for (const controls of [
    discover(source("index.html") + '<button data-fleet-action="new-action">'),
    discover(undefined, source("mobile-actions.js") + "control('New', 'new-action', {});"),
    discover(undefined, undefined, source("steer-panel.js") + "el('new-action').onclick = refresh;"),
  ]) expect(() => checkParity(fleetSurfaces, controls)).toThrow();
  expect(() => checkParity(fleetSurfaces.slice(1))).toThrow();
  for (const field of ["http", "cli"] as const) {
    const broken = structuredClone(fleetSurfaces);
    delete (broken[0] as Partial<typeof broken[number]>)[field];
    expect(() => checkParity(broken)).toThrow();
  }
});
test("printed manifest is JSON and discovering it never writes fleet data", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "surface-discover-")));
  try {
    const result = Bun.spawnSync([process.execPath, "scripts/fleet-surface.ts"], { cwd: repo, env: { ...process.env, HOME: home } });
    expect(result.exitCode).toBe(0); expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ schema_version: 1, actions: fleetSurfaces });
    expect(existsSync(join(home, ".ashlr"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
for (const args of [[], ["{"], ["{}", "{}"], ["null"], ['{"action":"pause"}']]) test(`action CLI refuses ${JSON.stringify(args)} without fleet writes`, () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "surface-refuse-")));
  try {
    const result = Bun.spawnSync([process.execPath, "scripts/fleet-act.ts", ...args], { cwd: repo, env: { ...process.env, HOME: home } });
    expect(result.exitCode).toBe(1); expect(result.stdout.toString()).toBe("");
    expect(JSON.parse(result.stderr.toString()).error).toBe("Invalid action or unavailable audit");
    expect(existsSync(join(home, ".ashlr"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test("action CLI defaults to an audited preview", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "surface-preview-")));
  const run = (args: string[]) => Bun.spawnSync([process.execPath, "scripts/fleet-act.ts", ...args], { cwd: repo, env: { ...process.env, HOME: home } });
  try {
    const result = run([JSON.stringify({ action: "pause", lane: "LANE", requested_by: "CALLER", reason: "REASON" })]);
    expect(result.exitCode).toBe(0); expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ dry_run: true, status: "dry_run" });
    expect(JSON.parse(readFileSync(join(home, ".ashlr/fleet/actions.jsonl"), "utf8"))).toMatchObject({ dry_run: true, status: "dry_run" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
for (const entry of fleetSurfaces) test(`${entry.id}: advertised HTTP/CLI examples reach the same validated operation`, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "surface-run-")));
  const server = startFleetUi({ root: join(home, "http"), port: 0 }), base = `http://127.0.0.1:${server.port}`;
  try {
    const pending = { id: "fixture", action: "set-slots", status: "proposed" };
    if (entry.id === "steer.refresh") for (const root of [join(home, ".ashlr/fleet"), join(home, "http/fleet")]) {
      mkdirSync(root, { recursive: true }); writeFileSync(join(root, "steer-proposals.jsonl"), JSON.stringify(pending) + "\n");
    }
    const result = Bun.spawnSync([process.execPath, ...entry.cli.slice(1)], { cwd: repo, env: { ...process.env, HOME: home } });
    expect(result.exitCode).toBe(0); expect(result.stderr.toString()).toBe("");
    const cli = JSON.parse(result.stdout.toString());
    const response = await fetch(base + entry.http.path, { method: entry.http.method,
      headers: { Origin: base, "Content-Type": "application/json" }, body: entry.http.body ? JSON.stringify(entry.http.body) : undefined });
    expect(response.status).toBe(entry.http.method === "POST" ? 202 : 200);
    const http = await response.json();
    if (entry.id.startsWith("control.")) {
      const payload = entry.http.body!.action as Record<string, unknown>;
      expect(cli).toMatchObject({ ...payload, status: "pending" }); expect(http).toMatchObject({ ...payload, status: "pending" });
    } else if (entry.http.method === "POST") {
      const { confirmed, ...proposal } = entry.http.body!;
      expect(cli.proposal).toMatchObject({ ...proposal, status: "proposed" }); expect(http.proposal).toMatchObject({ ...proposal, status: "proposed" });
    } else {
      expect(cli.proposals).toEqual([pending]); expect(http.proposals).toEqual([pending]);
    }
    if (entry.id.startsWith("control.")) {
      const before = readFileSync(join(home, ".ashlr/fleet/actions.jsonl"), "utf8");
      const invalid = Bun.spawnSync([process.execPath, "scripts/fleet-act.ts", '{"action":"unknown"}'], { cwd: repo, env: { ...process.env, HOME: home } });
      expect(invalid.exitCode).toBe(1); expect(invalid.stdout.toString()).toBe("");
      expect(readFileSync(join(home, ".ashlr/fleet/actions.jsonl"), "utf8")).toBe(before);
    }
  } finally { await server.stop(true); rmSync(home, { recursive: true, force: true }); }
});
