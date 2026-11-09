/**
 * pipe-server-grep-spaces.test.ts — a grep match in a file whose name contains
 * a space must reach the model as one intact `path:line:text` entry.
 *
 * The handler advertises `ctx.grep({pattern:'TODO',cwd:'my project'})`, so
 * spaces in paths are the documented case. The pipe returns the tool's text
 * unchanged (JSON-serialized), so the space must survive the join, the JSON
 * round trip, and `split("\n")` — and must not be quoted, escaped or split.
 *
 * Lives in its own file per AGENTS.md "Hot files" (pipe-server.test.ts is a
 * collision magnet). The final test runs the real grep handler end to end.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __restoreRegistryForTests,
  __snapshotRegistryForTests,
  registerTool,
  type ToolCallContext,
} from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

const toolBase = new URL("../servers/_tool-base.ts", import.meta.url).href;
const grepHandler = new URL("../servers/grep-server-handlers.ts", import.meta.url).href;
const pipeHandler = new URL("../servers/pipe-server-handlers.ts", import.meta.url).href;

const ctx: ToolCallContext = { sessionId: "pipe-server-grep-spaces", env: {} };

test("ctx.grep returns a match in a file with a space in its name as one intact entry", async () => {
  const grepText = "my project/my file.ts:3:TODO fix this\nmy project/plain.ts:1:TODO other\n";
  const registry = __snapshotRegistryForTests();
  const calls: Record<string, unknown>[] = [];
  try {
    registerTool({
      name: "ashlr__grep",
      description: "fixture",
      inputSchema: {},
      handler: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: grepText }] };
      },
    });
    const result = await ashlrPipe(
      { expr: "return await ctx.grep({pattern:'TODO',cwd:'my project'});" },
      ctx,
    );
    expect(JSON.parse(result.text)).toBe(grepText);

    // Inside the expression, the spaced path is still one `path:line:text` entry.
    const inner = await ashlrPipe(
      {
        expr:
          "const out = await ctx.grep({pattern:'TODO',cwd:'my project'});" +
          " return out.split('\\n').filter(Boolean).map(l => l.split(':')[0]);",
      },
      ctx,
    );
    expect(JSON.parse(inner.text)).toEqual(["my project/my file.ts", "my project/plain.ts"]);
    expect(calls).toEqual([
      { pattern: "TODO", cwd: "my project" },
      { pattern: "TODO", cwd: "my project" },
    ]);
  } finally {
    __restoreRegistryForTests(registry);
  }
});

test("the real grep handler reports a match in 'my file.ts' with the space intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipe-grep-spaces-"));
  const project = join(root, "project");
  const home = join(root, "home");
  try {
    await mkdir(join(project, "my project"), { recursive: true });
    await mkdir(home);
    await writeFile(join(project, "my file.ts"), "// TODO spaced name\nconst a = 1;\n", "utf8");
    await writeFile(join(project, "my project", "inner file.ts"), "x\n// TODO nested spaced\n", "utf8");
    await writeFile(join(project, "plain.ts"), "const b = 2;\n", "utf8");

    // A separate process confines the import-time pipe flag and registry.
    const script = `
      const { getTool } = await import(${JSON.stringify(toolBase)});
      await import(${JSON.stringify(grepHandler)});
      await import(${JSON.stringify(pipeHandler)});
      const pipe = getTool("ashlr__pipe");
      if (!pipe) throw new Error("pipe handler was not registered");
      const pipeCtx = { sessionId: "pipe-grep-spaces-test", env: process.env };
      const call = (args) => pipe.handler(
        { expr: 'return await ctx.grep(' + JSON.stringify(args) + ');', timeout_ms: 5000 },
        pipeCtx,
      );
      const root = await call({ pattern: "TODO", cwd: ".", bypassSummary: true });
      const nested = await call({ pattern: "TODO", cwd: "my project", bypassSummary: true });
      console.log(JSON.stringify({ root, nested }));
    `;
    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        ASHLR_HOME_OVERRIDE: home,
        CLAUDE_PROJECT_DIR: project,
        ASHLR_ALLOW_PROJECT_PATHS: "",
        ASHLR_PIPE_ENABLE: "1",
        ASHLR_GENOME_RETRIEVAL: "off",
        ASHLR_DISABLE_CLOUD_LLM: "1",
        ASHLR_CONTEXT_DB_DISABLE: "1",
        ASHLR_STATS_SYNC: "1",
        ASHLR_SESSION_LOG: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const { root: rootRes, nested } = JSON.parse(stdout);

    expect(rootRes.isError).not.toBe(true);
    const rootLines: string[] = JSON.parse(rootRes.content[0].text).split("\n");
    expect(rootLines.some((l) => l.endsWith("my file.ts:1:// TODO spaced name"))).toBe(true);
    expect(rootLines.some((l) => l.endsWith("my project/inner file.ts:2:// TODO nested spaced"))).toBe(true);
    expect(JSON.parse(rootRes.content[0].text)).not.toContain("plain.ts");

    // A cwd containing a space is accepted and the match reports the file name whole.
    expect(nested.isError).not.toBe(true);
    const nestedText: string = JSON.parse(nested.content[0].text);
    expect(nestedText).toContain("inner file.ts:2:// TODO nested spaced");
    expect(nestedText).not.toContain("my file.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
