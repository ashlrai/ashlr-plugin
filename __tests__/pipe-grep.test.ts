import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const toolBase = new URL("../servers/_tool-base.ts", import.meta.url).href;
const grepHandler = new URL("../servers/grep-server-handlers.ts", import.meta.url).href;
const pipeHandler = new URL("../servers/pipe-server-handlers.ts", import.meta.url).href;

test("documented grep pipe returns an empty list for a real search with no matches", async () => {
  const guide = await readFile(new URL("../docs/ashlr-pipe.md", import.meta.url), "utf8");
  const section = guide.split("### Example 2 — grep for TODOs with an empty-result check\n")[1]?.split("\n### ")[0];
  const request = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!request) throw new Error("Missing documented grep request");
  const { expr } = JSON.parse(request) as { expr: string };

  const root = await mkdtemp(join(tmpdir(), "pipe-grep-no-matches-"));
  const project = join(root, "project");
  const home = join(root, "home");
  try {
    await mkdir(project);
    await mkdir(home);
    await writeFile(join(project, "fixture.txt"), "nothing to do here\n");
    // Registration and project configuration are initialized at import time.
    const script = `
      globalThis.fetch = () => { throw new Error("Network access forbidden"); };
      const { getTool } = await import(${JSON.stringify(toolBase)});
      await import(${JSON.stringify(grepHandler)});
      await import(${JSON.stringify(pipeHandler)});
      const pipe = getTool("ashlr__pipe");
      if (!pipe) throw new Error("pipe handler was not registered");
      const result = await pipe.handler({ expr: ${JSON.stringify(expr)}, timeout_ms: 5000 },
        { sessionId: "pipe-grep-no-matches", env: process.env });
      console.log(JSON.stringify(result));
    `;
    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      cwd: project,
      env: {
        ...process.env, HOME: home, ASHLR_HOME_OVERRIDE: home, CLAUDE_PROJECT_DIR: project,
        ASHLR_ALLOW_PROJECT_PATHS: "", ASHLR_PIPE_ENABLE: "1", ASHLR_GENOME_RETRIEVAL: "off",
        ASHLR_DISABLE_CLOUD_LLM: "1", ASHLR_CONTEXT_DB_DISABLE: "1", ASHLR_STATS_SYNC: "1",
        ASHLR_SESSION_LOG: "0",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
