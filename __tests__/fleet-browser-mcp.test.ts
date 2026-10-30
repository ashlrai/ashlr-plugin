import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetBrowserCall } from "../servers/fleet-browser-server-handlers";
import { getTool } from "../servers/_tool-base";

let root: string, dir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-browser-mcp-")));
  dir = join(root, "fleet", "browser", "RQ-1");
  mkdirSync(join(dir, "frames"), { recursive: true });
  for (const n of [1, 2, 3]) writeFileSync(join(dir, `frames/${n}.png`), "png");
  writeFileSync(join(dir, "frames.jsonl"), [1, 2, 3].map(n => `{"path":"frames/${n}.png"}\n`).join(""));
  writeFileSync(join(dir, "current-url.txt"), "https://app.devin.ai/sessions/rq-1\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const call = (args: unknown) => fleetBrowserCall(args, root);
const handle = (args: unknown) => getTool("ashlr__fleet_browser")!.handler(args as Record<string, unknown>, { env: {} });

test("fleet_browser returns frames for a fixture job and pages by cursor", () => {
  const first = call({ job: "RQ-1", limit: 2 });
  expect(first).toMatchObject({ schema_version: 1, has_more: true,
    latest_frame_path: join(dir, "frames/3.png"), current_url: "https://app.devin.ai/sessions/rq-1" });
  expect(first.frames.map((frame: { index: number }) => frame.index)).toEqual([0, 1]);
  const second = call({ job: "RQ-1", limit: 2, cursor: first.cursor });
  expect(second.frames.map((frame: { index: number }) => frame.index)).toEqual([2]);
  expect(second.has_more).toBe(false);
  expect(call({ job: "RQ-1" }).frames).toHaveLength(3);
});

test("fleet_browser refuses traversal job ids and caller-selected paths", async () => {
  for (const job of ["../outside", "..", "a/b", "RQ 1", "-x", "RQ-1.jsonl", "/etc", "", ".env"]) {
    const result = await handle({ job });
    expect(result.isError, job).toBe(true);
  }
  for (const args of [{ root }, { job: "RQ-1", path: dir }, { job: "RQ-1", dir: root }, null, [], "RQ-1",
    { job: "RQ-1", job_id: "RQ-1" }, { job: 1 }, { job: null }]) {
    expect((await handle(args)).isError, JSON.stringify(args)).toBe(true);
  }
});

test("fleet_browser validates limit and cursor without touching disk", async () => {
  for (const limit of [0, 201, 1.5, "2", -1, null]) {
    expect((await handle({ job: "RQ-1", limit })).isError, JSON.stringify(limit)).toBe(true);
  }
  for (const cursor of ["bad", "{}", "null", 1, null]) {
    expect((await handle({ job: "RQ-1", cursor })).isError, JSON.stringify(cursor)).toBe(true);
  }
  const foreign = call({ job: "RQ-1" }).cursor;
  mkdirSync(join(root, "fleet", "browser", "RQ-2"), { recursive: true });
  writeFileSync(join(root, "fleet", "browser", "RQ-2", "frames.jsonl"), "");
  expect((await handle({ job: "RQ-2", cursor: foreign })).isError).toBe(true);
});

test("missing job dirs and linked parents fail closed like /api/browser", async () => {
  expect((await handle({ job: "RQ-9" })).isError).toBe(true);
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "frames.jsonl"), "");
  rmSync(dir, { recursive: true });
  symlinkSync(outside, dir);
  expect((await handle({ job: "RQ-1" })).isError).toBe(true);
  rmSync(join(root, "fleet", "browser"), { recursive: true });
  symlinkSync(join(root, "outside"), join(root, "fleet", "browser"));
  expect((await handle({ job: "RQ-1" })).isError).toBe(true);
});

test("MCP catalog lists the tool with the route-shaped schema", async () => {
  const tool = getTool("ashlr__fleet_browser")!;
  expect(tool).toBeTruthy();
  const catalog = await Bun.file(join(import.meta.dir, "../servers/_tool-catalog.json")).json();
  const entry = catalog.find((value: { name: string }) => value.name === "ashlr__fleet_browser");
  expect(entry).toMatchObject({ inputSchema: tool.inputSchema, module: "./fleet-browser-server-handlers" });
  expect(entry.enableEnv).toBeUndefined();
});

test("spawned handler reads the fixed HOME browser dir", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "fleet-browser-home-")));
  try {
    const jobDir = join(home, ".ashlr", "fleet", "browser", "RQ-7");
    mkdirSync(join(jobDir, "frames"), { recursive: true });
    writeFileSync(join(jobDir, "frames/1.png"), "png");
    writeFileSync(join(jobDir, "frames.jsonl"), '{"path":"frames/1.png"}\n');
    writeFileSync(join(jobDir, "current-url.txt"), "https://example.test/rq-7\n");
    const servers = join(import.meta.dir, "../servers");
    const run = (args: Record<string, unknown>) => Bun.spawnSync([process.execPath, "-e", `
      await import('${join(servers, "fleet-browser-server-handlers.ts")}');
      const { getTool } = await import('${join(servers, "_tool-base.ts")}');
      console.log(JSON.stringify(await getTool('ashlr__fleet_browser').handler(${JSON.stringify(args)}, { env: {} })));
    `], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
    const ok = run({ job: "RQ-7" });
    expect(ok.exitCode).toBe(0);
    const view = JSON.parse(JSON.parse(ok.stdout.toString()).content[0].text);
    expect(view).toMatchObject({ schema_version: 1, current_url: "https://example.test/rq-7",
      latest_frame_path: join(jobDir, "frames/1.png"), has_more: false });
    expect(view.frames).toEqual([{ index: 0, path: join(jobDir, "frames/1.png") }]);
    for (const args of [{ job: "../escape" }, { job: "RQ-9" }]) {
      const refused = run(args);
      expect(refused.exitCode).toBe(0);
      expect(JSON.parse(refused.stdout.toString()).isError).toBe(true);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
