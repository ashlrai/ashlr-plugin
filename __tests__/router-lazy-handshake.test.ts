/**
 * initialize and tools/list stay the same when tool implementations load lazily.
 *
 * The fixture is the eager router's handshake. The catalog, a fresh eager
 * import, and a spawned lazy router must all match it. No timing assertions.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import pkg from "../package.json" with { type: "json" };
import fixture from "./fixtures/mcp-handshake.json" with { type: "json" };
import { LAZY_TOOLS } from "../servers/_tool-catalog";

const ROOT = resolve(import.meta.dir, "..");
const ROUTER = join(ROOT, "servers", "_router.ts");

interface ToolShape {
  name: string;
  description: string;
  inputSchema: unknown;
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "lazy-handshake", version: "1" },
  },
};

function catalogTools(pipe: boolean): ToolShape[] {
  return LAZY_TOOLS.filter((tool) => pipe || !tool.enableEnv).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function childEnv(home: string, pipe: boolean): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    ASHLR_STATS_SYNC: "1",
    ASHLR_SESSION_LOG: "0",
    ASHLR_MCP_HOST: "generic",
  };
  if (pipe) env.ASHLR_PIPE_ENABLE = "1";
  else delete env.ASHLR_PIPE_ENABLE;
  return env;
}

async function rpc(
  reqs: unknown[],
  home: string,
  pipe: boolean,
): Promise<Array<{ id: number; result?: any }>> {
  const proc = spawn({
    cmd: ["bun", "run", ROUTER],
    cwd: ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(home, pipe),
  });
  proc.stdin.write(reqs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await proc.stdin.end();
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`router exit ${code}\n${err}\n${out.slice(0, 400)}`);
  }
  return out
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function eagerTools(home: string, pipe: boolean): Promise<ToolShape[]> {
  const proc = spawn({
    cmd: [
      "bun",
      "-e",
      [
        'const { listTools, __resetRegistryForTests } = await import("./servers/_tool-base.ts");',
        "__resetRegistryForTests();",
        'await import("./servers/_router-handlers.ts");',
        "const tools = listTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));",
        "process.stdout.write(JSON.stringify(tools));",
      ].join(" "),
    ],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(home, pipe),
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`eager import exit ${code}\n${err}`);
  return JSON.parse(out);
}

describe("router lazy handshake", () => {
  test("initialize and tools/list match the eager registry", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-lazy-hs-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
    try {
      expect(catalogTools(false)).toEqual(fixture.tools);
      expect(await eagerTools(home, false)).toEqual(fixture.tools);

      const [init, list] = await rpc(
        [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
        home,
        false,
      );
      expect(init.result).toEqual({
        ...fixture.initialize,
        serverInfo: {
          ...fixture.initialize.serverInfo,
          version: process.env.ASHLR_VERSION || pkg.version,
        },
      });
      expect(list.result.tools).toEqual(fixture.tools);

      const responses = await rpc(
        [
          INIT,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "ashlr__read", arguments: { path: resolve("/") } },
          },
        ],
        home,
        false,
      );
      const call = responses.find((message) => message.id === 2);
      expect(call?.result.isError).toBe(true);
      expect(call?.result.content[0].text).toContain("refused path outside working directory");
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);

  test("ASHLR_PIPE_ENABLE=1 lists ashlr__pipe in the same place", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-lazy-pipe-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
    try {
      expect(catalogTools(true)).toEqual(fixture.toolsWithPipe);
      expect(await eagerTools(home, true)).toEqual(fixture.toolsWithPipe);
      const [, list] = await rpc(
        [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
        home,
        true,
      );
      expect(list.result.tools).toEqual(fixture.toolsWithPipe);
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);
});
