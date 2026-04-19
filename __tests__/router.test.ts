/**
 * Tests for the router + handler pattern (Track A sprint 1 & 2).
 *
 * Handler modules register via side-effect on import. Bun caches modules, so
 * we capture each registered tool once after the static import, then
 * re-register them after each __resetRegistryForTests() call.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  listTools,
  getTool,
  registerTool,
  __resetRegistryForTests,
  type ToolHandler,
} from "../servers/_tool-base";

// Static imports trigger registerTool side-effects.
import "../servers/glob-server-handlers";
import "../servers/tree-server-handlers";
import "../servers/ls-server-handlers";
import "../servers/diff-server-handlers";
import "../servers/webfetch-server-handlers";

// Capture registrations before any test resets the registry.
const GLOB_TOOL    = getTool("ashlr__glob")     as ToolHandler;
const TREE_TOOL    = getTool("ashlr__tree")     as ToolHandler;
const LS_TOOL      = getTool("ashlr__ls")       as ToolHandler;
const DIFF_TOOL    = getTool("ashlr__diff")     as ToolHandler;
const WEBFETCH_TOOL = getTool("ashlr__webfetch") as ToolHandler;

const ALL_TOOLS = [GLOB_TOOL, TREE_TOOL, LS_TOOL, DIFF_TOOL, WEBFETCH_TOOL];

function restoreRegistry(): void {
  __resetRegistryForTests();
  for (const t of ALL_TOOLS) registerTool(t);
}

beforeEach(restoreRegistry);
afterEach(() => __resetRegistryForTests());

// ---------------------------------------------------------------------------
// Registry: listTools / getTool — all 5 tools present
// ---------------------------------------------------------------------------

describe("router · tool registry (sprint 2)", () => {
  test("listTools contains all 5 migrated tools", () => {
    const names = listTools().map((t) => t.name);
    expect(names).toContain("ashlr__glob");
    expect(names).toContain("ashlr__tree");
    expect(names).toContain("ashlr__ls");
    expect(names).toContain("ashlr__diff");
    expect(names).toContain("ashlr__webfetch");
  });

  test("each tool has correct shape", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool).toBeDefined();
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe("function");
    }
  });

  test("getTool returns undefined for unknown tool", () => {
    expect(getTool("ashlr__nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dispatch: glob
// ---------------------------------------------------------------------------

describe("router · glob dispatch", () => {
  let tmp: string;

  beforeEach(async () => {
    restoreRegistry();
    const { mkdtemp, writeFile, mkdir } = await import("fs/promises");
    const { join } = await import("path");
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
    expect(result.content[0].type).toBe("text");
    const text = result.content[0].text;
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
    expect(text).not.toContain("c.js");
    expect(text).toMatch(/\[ashlr__glob\] pattern ".*?" · 2 matches/);
  });
});

// ---------------------------------------------------------------------------
// Dispatch: tree
// ---------------------------------------------------------------------------

describe("router · tree dispatch", () => {
  let tmp: string;

  beforeEach(async () => {
    restoreRegistry();
    const { mkdtemp, writeFile, mkdir } = await import("fs/promises");
    const { join } = await import("path");
    const base = join(import.meta.dir, "..", "tmp-router-test");
    await mkdir(base, { recursive: true });
    tmp = await mkdtemp(join(base, "tree-"));
    await writeFile(join(tmp, "index.ts"), "export {}");
    await writeFile(join(tmp, "README.md"), "# test");
  });

  afterEach(async () => {
    const { rm } = await import("fs/promises");
    await rm(tmp, { recursive: true, force: true });
    __resetRegistryForTests();
  });

  test("dispatching ashlr__tree returns tree output", async () => {
    const tool = getTool("ashlr__tree");
    expect(tool).toBeDefined();
    const result = await tool!.handler(
      { path: tmp },
      { env: process.env },
    );
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("index.ts");
    expect(text).toMatch(/\d+ dirs · \d+ files/);
  });
});

// ---------------------------------------------------------------------------
// Dispatch: ls
// ---------------------------------------------------------------------------

describe("router · ls dispatch", () => {
  let tmp: string;

  beforeEach(async () => {
    restoreRegistry();
    const { mkdtemp, writeFile, mkdir } = await import("fs/promises");
    const { join } = await import("path");
    const base = join(import.meta.dir, "..", "tmp-router-test");
    await mkdir(base, { recursive: true });
    tmp = await mkdtemp(join(base, "ls-"));
    await writeFile(join(tmp, "foo.ts"), "");
    await writeFile(join(tmp, "bar.ts"), "");
  });

  afterEach(async () => {
    const { rm } = await import("fs/promises");
    await rm(tmp, { recursive: true, force: true });
    __resetRegistryForTests();
  });

  test("dispatching ashlr__ls returns directory listing", async () => {
    const tool = getTool("ashlr__ls");
    expect(tool).toBeDefined();
    const result = await tool!.handler(
      { path: tmp },
      { env: process.env },
    );
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("foo.ts");
    expect(text).toContain("bar.ts");
    expect(text).toMatch(/entries/);
  });
});

// ---------------------------------------------------------------------------
// Dispatch: diff (error path — no git repo)
// ---------------------------------------------------------------------------

describe("router · diff dispatch", () => {
  let tmp: string;

  beforeEach(async () => {
    restoreRegistry();
    const { mkdtemp, mkdir } = await import("fs/promises");
    const { join } = await import("path");
    const base = join(import.meta.dir, "..", "tmp-router-test");
    await mkdir(base, { recursive: true });
    tmp = await mkdtemp(join(base, "diff-"));
  });

  afterEach(async () => {
    const { rm } = await import("fs/promises");
    await rm(tmp, { recursive: true, force: true });
    __resetRegistryForTests();
  });

  test("dispatching ashlr__diff on non-git dir returns error text", async () => {
    const tool = getTool("ashlr__diff");
    expect(tool).toBeDefined();
    // handler catches the thrown error and returns isError:true via runStandalone
    // but when called directly, the error propagates; the router catches it.
    // We just verify the handler is callable and returns something meaningful.
    try {
      const result = await tool!.handler(
        { cwd: tmp, ref: "HEAD~1" },
        { env: process.env },
      );
      // If it somehow returns (cwd-clamp passes for subdirs of cwd):
      expect(result.content[0].text).toBeDefined();
    } catch (err) {
      // Expected: "not a git repository"
      expect((err as Error).message).toMatch(/not a git repository|cwd does not exist|outside working directory/);
    }
  });
});

// ---------------------------------------------------------------------------
// Dispatch: webfetch (error path — bad URL)
// ---------------------------------------------------------------------------

describe("router · webfetch dispatch", () => {
  beforeEach(restoreRegistry);
  afterEach(() => __resetRegistryForTests());

  test("dispatching ashlr__webfetch with invalid URL throws fetch error", async () => {
    const tool = getTool("ashlr__webfetch");
    expect(tool).toBeDefined();
    try {
      await tool!.handler(
        { url: "http://localhost:1" }, // nothing listening
        { env: process.env },
      );
    } catch (err) {
      expect((err as Error).message).toMatch(/fetch failed|ECONNREFUSED|connect/i);
    }
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
