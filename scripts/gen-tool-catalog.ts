#!/usr/bin/env bun
/**
 * Derive servers/_tool-catalog.json from the live tool registry.
 *
 * The stdio router reads this file for initialize and tools/list. Handler
 * modules stay unloaded until the first tools/call. Descriptions and schemas
 * come from registerTool(), so they are not copied by hand.
 *
 *   bun run gen:tool-catalog
 *   bun run gen:tool-catalog -- --check
 *
 * --check exits 1 when the committed file differs. The lazy handshake test
 * runs it, so CI fails on a stale catalog.
 */

import { spawn } from "bun";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
export const CATALOG_PATH = join(ROOT, "servers", "_tool-catalog.json");
export const GENERATOR_COMMAND = "bun run gen:tool-catalog";

const AGGREGATOR = join(ROOT, "servers", "_router-handlers.ts");

export interface CatalogTool {
  name: string;
  description: string;
  inputSchema: unknown;
  /** Specifier resolved from servers/_lazy-tools.ts. */
  module: string;
  /** Registered only when process.env[enableEnv] === "1". */
  enableEnv?: string;
}

interface LiveTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** Tool names registered by a handler file. Matches `name: "ashlr__..."`. */
export function declaredToolNames(source: string): string[] {
  return [...source.matchAll(/^[ \t]*name: "(ashlr__[a-z0-9_]+)",?[ \t]*$/gm)].map(
    (match) => match[1],
  );
}

function aggregatorModules(source: string): string[] {
  return [...source.matchAll(/^import "\.\/([a-z0-9-]+-server-handlers)";/gm)].map(
    (match) => match[1],
  );
}

async function liveTools(pipe: boolean, home: string): Promise<LiveTool[]> {
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
    env,
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`eager import exit ${code}\n${err}`);
  }
  return JSON.parse(out) as LiveTool[];
}

export async function buildCatalog(): Promise<CatalogTool[]> {
  const home = await mkdtemp(join(tmpdir(), "ashlr-gen-catalog-"));
  try {
    const [withPipe, withoutPipe, aggregator] = await Promise.all([
      liveTools(true, home),
      liveTools(false, home),
      readFile(AGGREGATOR, "utf8"),
    ]);
    const off = new Set(withoutPipe.map((tool) => tool.name));
    const modules = aggregatorModules(aggregator);
    if (modules.length === 0) {
      throw new Error(`${AGGREGATOR} has no handler imports`);
    }

    const owner = new Map<string, string>();
    for (const file of modules) {
      const source = await readFile(join(ROOT, "servers", `${file}.ts`), "utf8");
      for (const name of declaredToolNames(source)) {
        const prev = owner.get(name);
        if (prev) {
          throw new Error(`${name} is registered in both ${prev} and ./${file}`);
        }
        owner.set(name, `./${file}`);
      }
    }

    const catalog: CatalogTool[] = withPipe.map((tool) => {
      const module = owner.get(tool.name);
      if (!module) {
        throw new Error(
          `${tool.name} is in the registry but no handler imported by _router-handlers.ts declares it`,
        );
      }
      const entry: CatalogTool = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        module,
      };
      if (!off.has(tool.name)) entry.enableEnv = "ASHLR_PIPE_ENABLE";
      return entry;
    });

    const extra = [...owner.keys()].filter((name) => !catalog.some((tool) => tool.name === name));
    if (extra.length > 0) {
      throw new Error(`declared but not registered with ASHLR_PIPE_ENABLE=1: ${extra.join(", ")}`);
    }

    const filtered = catalog.filter((tool) => !tool.enableEnv).map((tool) => tool.name);
    const offNames = withoutPipe.map((tool) => tool.name);
    if (filtered.join("\n") !== offNames.join("\n")) {
      throw new Error("flag-off tool order does not match the catalog with gated tools removed");
    }
    return catalog;
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

export function catalogText(catalog: CatalogTool[]): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function firstDifference(committed: string, generated: string): string {
  const left = committed.split("\n");
  const right = generated.split("\n");
  const lines = Math.max(left.length, right.length);
  for (let i = 0; i < lines; i++) {
    if (left[i] !== right[i]) {
      return [
        `first difference at line ${i + 1}`,
        `committed: ${left[i] ?? "<missing>"}`,
        `generated: ${right[i] ?? "<missing>"}`,
      ].join("\n");
    }
  }
  return "files differ";
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const generated = catalogText(await buildCatalog());
  if (check) {
    let committed = "";
    try {
      committed = await readFile(CATALOG_PATH, "utf8");
    } catch {
      committed = "";
    }
    if (committed !== generated) {
      process.stderr.write(
        `servers/_tool-catalog.json is stale.\n${firstDifference(committed, generated)}\nRun: ${GENERATOR_COMMAND}\n`,
      );
      process.exit(1);
    }
    return;
  }
  await writeFile(CATALOG_PATH, generated);
  process.stdout.write(`wrote ${CATALOG_PATH}\n`);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
