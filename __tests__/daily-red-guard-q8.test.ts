import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import catalog from "../servers/_tool-catalog.json";
import { buildProduct, syncSite } from "../site/scripts/freshness";
import { syncToolCounts } from "../scripts/sync-tool-counts";

const root = resolve(import.meta.dir, "..");
const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "daily-red-q8-"));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Exercise the real SDK lifecycle, rather than sending tools/list before the
// initialized notification. Both advertised sets must retain registry order.
for (const pipe of [false, true]) {
  test(`SDK launch lists the canonical catalog (pipe=${pipe})`, async () => {
    const client = new Client({ name: "daily-red-guard", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "scripts/mcp-entrypoint.ts"), "servers/_router.ts"],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "", HOME: home(),
        ASHLR_PIPE_ENABLE: pipe ? "1" : "0", ASHLR_MCP_HOST: "generic",
        ASHLR_CONTEXT_DB_DISABLE: "1", ASHLR_SESSION_LOG: "0", ASHLR_STATS_SYNC: "1",
      },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect<unknown>(tools).toEqual(catalog.filter(tool => !tool.enableEnv || pipe).map(
        ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
      ));
      for (const tool of tools) {
        expect(tool.description!.length).toBeGreaterThanOrEqual(80);
        expect(tool.description!.length).toBeLessThanOrEqual(500);
      }
    } finally {
      await client.close();
      await transport.close();
    }
  }, 20_000);
}

test("default metadata and generated site agree with the advertised catalog", () => {
  expect(syncToolCounts(root, true).changed).toEqual([]);
  expect(buildProduct(root).counts.mcpTools).toBe(catalog.filter(tool => !tool.enableEnv).length);
  expect(() => syncSite(true, root)).not.toThrow();
});

test("watcher no-genome path settles with a successful exit code", async () => {
  const { main } = await import("../scripts/genome-commit-watcher");
  await expect(main(["--cwd", home()])).resolves.toBe(0);
});

test("ghost CLI emits a single JSON report and rejects a missing directory", () => {
  // HOME stays the temp dir so bun and macOS may drop .bun/Library there;
  // the runs dir the CLI scans is a dedicated empty subfolder beside them.
  const dir = home();
  const runs = join(dir, "runs");
  mkdirSync(runs);
  const run = (path: string) => Bun.spawnSync([
    process.execPath, join(root, "scripts/fleet-ghosts.ts"), path,
  ], { env: { HOME: dir, PATH: "/usr/bin:/bin" }, timeout: 10_000 });
  const empty = run(runs);
  expect(empty.exitCode).toBe(0);
  expect(empty.stderr.toString()).toBe("");
  expect(JSON.parse(empty.stdout.toString())).toMatchObject({ lanes: [], counts: { ghosts: 0 } });
  const missing = run(join(runs, "missing"));
  expect(missing.exitCode).toBe(1);
  expect(missing.stdout.toString()).toBe("");
  expect(missing.stderr.toString()).toContain("ENOENT");
}, 20_000);
