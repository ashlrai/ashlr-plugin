/**
 * initialize and tools/list stay aligned with the generated catalog.
 *
 * The catalog is produced by `bun run gen:tool-catalog`. This file checks
 * that the committed JSON matches a fresh eager import, that a spawned lazy
 * router serves that list, and that every catalog module actually registers
 * its tool. No timing assertions.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import pkg from "../package.json" with { type: "json" };
import { GENERATOR_COMMAND, declaredToolNames } from "../scripts/gen-tool-catalog";
import { MCP_EFFICIENCY_INSTRUCTIONS } from "../servers/_tool-base";
import catalog from "../servers/_tool-catalog.json" with { type: "json" };

const ROOT = resolve(import.meta.dir, "..");
const ROUTER = join(ROOT, "servers", "_router.ts");

interface ToolShape {
  name: string;
  description: string;
  inputSchema: unknown;
  module: string;
  enableEnv?: string;
}

const LAZY_TOOLS = catalog as ToolShape[];

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
    module: tool.module,
    ...(tool.enableEnv ? { enableEnv: tool.enableEnv } : {}),
  }));
}

function publicTools(pipe: boolean): Array<Pick<ToolShape, "name" | "description" | "inputSchema">> {
  return catalogTools(pipe).map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

function childEnv(home: string, pipe: boolean): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    ASHLR_STATS_SYNC: "1",
    ASHLR_SESSION_LOG: "0",
    ASHLR_MCP_HOST: "generic",
    ASHLR_CONTEXT_DB_DISABLE: "1",
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

/** Tools registered by importing only this catalog module in a fresh process. */
async function toolsRegisteredBy(module: string, home: string): Promise<string[]> {
  const file = `./servers/${module.slice(2)}.ts`;
  const proc = spawn({
    cmd: [
      "bun",
      "-e",
      [
        'const { listTools, __resetRegistryForTests } = await import("./servers/_tool-base.ts");',
        "__resetRegistryForTests();",
        `await import(${JSON.stringify(file)});`,
        "process.stdout.write(JSON.stringify(listTools().map((t) => t.name)));",
      ].join(" "),
    ],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(home, true),
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`import ${module} exit ${code}\n${err}`);
  return JSON.parse(out) as string[];
}

/**
 * The declared module must register the tool itself. A transitive import
 * (ask-server pulls in read) is not enough: the handler file has to contain
 * the registerTool name.
 */
function assertModuleExportsTool(
  name: string,
  module: string,
  source: string,
  registered: readonly string[],
): void {
  const declared = declaredToolNames(source);
  if (!declared.includes(name) || !registered.includes(name)) {
    throw new Error(
      `${name} was not registered by ${module}. Fix the catalog module or run: ${GENERATOR_COMMAND}`,
    );
  }
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

describe("router lazy handshake", () => {
  test("pipe catalog description identifies its experimental, opt-in status", () => {
    const pipe = LAZY_TOOLS.find((tool) => tool.name === "ashlr__pipe");
    expect(pipe).toBeDefined();
    expect(pipe!.description).toContain("[EXPERIMENTAL]");
    expect(pipe!.description).toContain("off by default, enable with ASHLR_PIPE_ENABLE=1");
    expect(pipe!.enableEnv).toBe("ASHLR_PIPE_ENABLE");
  });

  test("committed catalog matches the generator", async () => {
    const proc = spawn({
      cmd: ["bun", "run", "scripts/gen-tool-catalog.ts", "--check"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ASHLR_STATS_SYNC: "1", ASHLR_SESSION_LOG: "0" },
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`${err || out}\nCatalog is stale. Run: ${GENERATOR_COMMAND}`);
    }
  }, 30_000);

  test("initialize and tools/list match the catalog", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-lazy-hs-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
    try {
      const [init, list] = await rpc(
        [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
        home,
        false,
      );
      expect(init.result).toEqual({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "ashlr-router",
          version: process.env.ASHLR_VERSION || pkg.version,
        },
        instructions: MCP_EFFICIENCY_INSTRUCTIONS,
      });
      expect(list.result.tools).toEqual(publicTools(false));

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
      const [, list] = await rpc(
        [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
        home,
        true,
      );
      expect(list.result.tools).toEqual(publicTools(true));
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);

  test("every catalog module registers its tool", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-mod-"));
    const registered = new Map<string, string[]>();
    const sources = new Map<string, string>();
    try {
      const modules = [...new Set(LAZY_TOOLS.map((tool) => tool.module))];
      await mapPool(modules, 4, async (module) => {
        const [names, source] = await Promise.all([
          toolsRegisteredBy(module, home),
          readFile(join(ROOT, "servers", `${module.slice(2)}.ts`), "utf8"),
        ]);
        registered.set(module, names);
        sources.set(module, source);
      });
      for (const spec of LAZY_TOOLS) {
        assertModuleExportsTool(
          spec.name,
          spec.module,
          sources.get(spec.module) ?? "",
          registered.get(spec.module) ?? [],
        );
      }
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  test("a deliberately wrong module entry fails the check", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-mod-wrong-"));
    try {
      const registered = await toolsRegisteredBy("./grep-server-handlers", home);
      const source = await readFile(join(ROOT, "servers", "grep-server-handlers.ts"), "utf8");
      expect(registered).toContain("ashlr__grep");
      expect(() =>
        assertModuleExportsTool("ashlr__read", "./grep-server-handlers", source, registered),
      ).toThrow(
        "ashlr__read was not registered by ./grep-server-handlers. Fix the catalog module or run: bun run gen:tool-catalog",
      );
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);
});
