import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const toolBase = new URL("../servers/_tool-base.ts", import.meta.url).href;
const grepHandler = new URL("../servers/grep-server-handlers.ts", import.meta.url).href;
const pipeHandler = new URL("../servers/pipe-server-handlers.ts", import.meta.url).href;

test("pipe returns the real grep no-match text as a JSON string offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipe-grep-empty-"));
  const project = join(root, "project");
  const home = join(root, "home");
  try {
    await mkdir(project);
    await mkdir(home);
    await writeFile(join(project, "fixture.txt"), "present-marker\n");

    // A separate process confines the import-time pipe flag and registry.
    const script = `
      let fetchCalls = 0;
      globalThis.fetch = () => { fetchCalls++; throw new Error("Network access forbidden"); };
      const { getTool } = await import(${JSON.stringify(toolBase)});
      await import(${JSON.stringify(grepHandler)});
      await import(${JSON.stringify(pipeHandler)});
      const pipe = getTool("ashlr__pipe");
      if (!pipe) throw new Error("pipe handler was not registered");
      const call = (pattern) => pipe.handler({
        expr: 'return await ctx.grep({pattern: ' + JSON.stringify(pattern) + ', cwd: ".", bypassSummary: true});',
        timeout_ms: 5000,
      }, { sessionId: "pipe-grep-empty-test", env: process.env });
      const empty = await call("absent-marker");
      const present = await call("present-marker");
      console.log(JSON.stringify({ empty, present, fetchCalls }));
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
    const { empty, present, fetchCalls } = JSON.parse(stdout);
    expect(fetchCalls).toBe(0);
    expect(empty).toEqual({ content: [{ type: "text", text: '"[no matches]"' }] });
    expect(present.isError).not.toBe(true);
    expect(JSON.parse(present.content[0].text)).toContain("fixture.txt:1:present-marker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
