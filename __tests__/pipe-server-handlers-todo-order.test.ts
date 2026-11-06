/**
 * pipe-server-handlers-todo-order.test.ts — a temporary fixture with several
 * TODO lines, grepped through the registered ashlr__pipe handler, must come
 * back in file order. Also pins the rollout flag: without ASHLR_PIPE_ENABLE=1
 * the handlers module registers nothing.
 *
 * Runs in a child process so the import-time flag and tool registry stay
 * isolated from the rest of the suite; HOME points at a temp dir.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const toolBase = new URL("../servers/_tool-base.ts", import.meta.url).href;
const grepHandler = new URL("../servers/grep-server-handlers.ts", import.meta.url).href;
const pipeHandler = new URL("../servers/pipe-server-handlers.ts", import.meta.url).href;

async function run(project: string, home: string, enable: string, script: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "-e", script],
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      ASHLR_HOME_OVERRIDE: home,
      CLAUDE_PROJECT_DIR: project,
      ASHLR_ALLOW_PROJECT_PATHS: "",
      ASHLR_PIPE_ENABLE: enable,
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
  return JSON.parse(stdout);
}

test("pipe handler's ctx.grep returns fixture TODO lines in file order; flag gates registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipe-handlers-todo-"));
  const project = join(root, "project");
  const home = join(root, "home");
  try {
    await mkdir(project, { recursive: true });
    await mkdir(home);
    const fixture = [
      "// TODO alpha",
      "const a = 1;",
      "// TODO bravo",
      "// FIXME not a match",
      "const b = 2;",
      "// TODO charlie",
      "// TODO delta",
      "",
    ].join("\n");
    await writeFile(join(project, "fixture.ts"), fixture, "utf8");

    const script = `
      const { getTool } = await import(${JSON.stringify(toolBase)});
      await import(${JSON.stringify(grepHandler)});
      await import(${JSON.stringify(pipeHandler)});
      const pipe = getTool("ashlr__pipe");
      if (!pipe) { console.log(JSON.stringify({ registered: false })); }
      else {
        const res = await pipe.handler(
          { expr: "return await ctx.grep({pattern:'TODO',cwd:'.',bypassSummary:true});", timeout_ms: 5000 },
          { sessionId: "pipe-handlers-todo-order", env: process.env },
        );
        console.log(JSON.stringify({ registered: true, res }));
      }
    `;

    const off = await run(project, home, "", script);
    expect(off.registered).toBe(false);

    const on = await run(project, home, "1", script);
    expect(on.registered).toBe(true);
    expect(on.res.isError).not.toBe(true);
    const out: string = JSON.parse(on.res.content[0].text);
    const hits = out
      .split("\n")
      .map((l) => /fixture\.ts:(\d+):(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [Number(m[1]), m[2]]);
    expect(hits).toEqual([
      [1, "// TODO alpha"],
      [3, "// TODO bravo"],
      [6, "// TODO charlie"],
      [7, "// TODO delta"],
    ]);
    expect(out).not.toContain("FIXME");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
