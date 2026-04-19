/**
 * Tests for the router + handler pattern (Track A sprint 1).
 *
 * Handler modules register via side-effect on import. Bun caches modules, so
 * we capture the registered tool once after the static import, then
 * re-register it after each __resetRegistryForTests() call.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  listTools,
  getTool,
  registerTool,
  __resetRegistryForTests,
  type ToolHandler,
} from "../servers/_tool-base";

// Static import triggers registerTool("ashlr__glob") as a side-effect.
import "../servers/glob-server-handlers";

// Capture the registration before any test resets the registry.
const GLOB_TOOL = getTool("ashlr__glob") as ToolHandler;

function restoreRegistry(): void {
  __resetRegistryForTests();
  registerTool(GLOB_TOOL);
}

beforeEach(restoreRegistry);
afterEach(() => __resetRegistryForTests());

// ---------------------------------------------------------------------------
// Registry: listTools / getTool
// ---------------------------------------------------------------------------

describe("router · tool registry", () => {
  test("listTools returns ashlr__glob after handlers module is loaded", () => {
    const names = listTools().map((t) => t.name);
    expect(names).toContain("ashlr__glob");
  });

  test("getTool returns the glob handler with correct shape", () => {
    const tool = getTool("ashlr__glob");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("ashlr__glob");
    expect(tool!.description).toContain("token");
    expect(tool!.inputSchema).toBeDefined();
    expect(typeof tool!.handler).toBe("function");
  });

  test("getTool returns undefined for unknown tool", () => {
    expect(getTool("ashlr__nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dispatch: router calls glob handler and gets expected format
// ---------------------------------------------------------------------------

describe("router · glob dispatch", () => {
  let tmp: string;

  beforeEach(async () => {
    restoreRegistry();
    const { mkdtemp, writeFile, mkdir } = await import("fs/promises");
    const { join } = await import("path");
    // Use a subdir of the worktree so the cwd-clamp (process.cwd()) passes.
    const base = join(import.meta.dir, "..", "tmp-router-test");
    await mkdir(base, { recursive: true });
    tmp = await mkdtemp(join(base, "run-"));
    await writeFile(join(tmp, "a.ts"), "");
    await writeFile(join(tmp, "b.ts"), "");
    await writeFile(join(tmp, "c.js"), "");
  });

  afterEach(async () => {
    const { rm } = await import("fs/promises");
    await rm(tmp, { recursive: true, force: true });
    __resetRegistryForTests();
  });

  test("dispatching ashlr__glob returns correct output format", async () => {
    const tool = getTool("ashlr__glob");
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      { pattern: "*.ts", cwd: tmp },
      { env: process.env },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = result.content[0].text;
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
    expect(text).not.toContain("c.js");
    expect(text).toMatch(/\[ashlr__glob\] pattern ".*?" · 2 matches/);
  });
});

// ---------------------------------------------------------------------------
// ASHLR_ROUTER_DISABLE=1 — router exits early
// ---------------------------------------------------------------------------

describe("router · ASHLR_ROUTER_DISABLE", () => {
  test("process exits 0 when ASHLR_ROUTER_DISABLE=1", async () => {
    const { spawn } = await import("bun");
    const { join } = await import("path");

    const routerPath = join(import.meta.dir, "..", "servers", "_router.ts");
    const proc = spawn({
      cmd: ["bun", "run", routerPath],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ASHLR_ROUTER_DISABLE: "1" },
    });
    await proc.stdin.end();
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toContain("ASHLR_ROUTER_DISABLE=1");
  });
});
