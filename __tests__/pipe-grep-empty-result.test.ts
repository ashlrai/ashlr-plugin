import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const toolBase = new URL("../servers/_tool-base.ts", import.meta.url).href;
const grepHandler = new URL("../servers/grep-server-handlers.ts", import.meta.url).href;
const pipeHandler = new URL("../servers/pipe-server-handlers.ts", import.meta.url).href;

test("guide and advertised grep examples return real results as splittable text", async () => {
  const guide = await readFile(new URL("../docs/ashlr-pipe.md", import.meta.url), "utf8");
  const section = guide.split("### Return grep output from a working directory\n")[1]?.split("\n### ")[0];
  const request = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!request) throw new Error("Missing documented grep request");
  const { expr } = JSON.parse(request) as { expr: string };

  const root = await mkdtemp(join(tmpdir(), "pipe-grep-examples-"));
  const project = join(root, "project");
  const home = join(root, "home");
  try {
    await mkdir(join(project, "my project"), { recursive: true });
    await mkdir(home);
    await writeFile(join(project, "my project", "fixture.txt"), "TODO first\nignored\nTODO second\n");

    // Isolate the import-time registration flag and prohibit network access.
    const script = `
      let fetchCalls = 0;
      globalThis.fetch = () => { fetchCalls++; throw new Error("Network access forbidden"); };
      const { getTool } = await import(${JSON.stringify(toolBase)});
      await import(${JSON.stringify(grepHandler)});
      await import(${JSON.stringify(pipeHandler)});
      const pipe = getTool("ashlr__pipe");
      if (!pipe) throw new Error("pipe handler was not registered");
      const advertised = pipe.description.match(/Example: \\x60([^\\x60]+)\\x60/)?.[1];
      if (!advertised) throw new Error("Missing handler example");
      const ctx = { sessionId: "pipe-grep-examples-test", env: process.env };
      const results = [];
      for (const expr of [${JSON.stringify(expr)}, advertised]) {
        results.push(await pipe.handler({ expr, timeout_ms: 5000 }, ctx));
      }
      console.log(JSON.stringify({ results, fetchCalls }));
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
    const { results, fetchCalls } = JSON.parse(stdout);
    expect(fetchCalls).toBe(0);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.isError).not.toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const output = JSON.parse(result.content[0].text);
      expect(typeof output).toBe("string");
      const lines = output.split("\n");
      expect(lines.some((line: string) => line.includes("fixture.txt:1:TODO first"))).toBe(true);
      expect(lines.some((line: string) => line.includes("fixture.txt:3:TODO second"))).toBe(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

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
