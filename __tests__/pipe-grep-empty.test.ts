import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const toolBase = new URL("../servers/_tool-base.ts", import.meta.url).href;
const grepHandler = new URL("../servers/grep-server-handlers.ts", import.meta.url).href;
const pipeHandler = new URL("../servers/pipe-server-handlers.ts", import.meta.url).href;

test("pipe preserves real grep no-match results without inventing matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipe-grep-empty-contract-"));
  const project = join(root, "project");
  const home = join(root, "home");
  try {
    await mkdir(join(project, "empty"), { recursive: true });
    await mkdir(home);
    await writeFile(join(project, "fixture.txt"), "present-marker\nother text\n");

    // Isolate registration and import-time configuration, and forbid network access.
    const script = `
      globalThis.fetch = () => { throw new Error("Network access forbidden"); };
      const { getTool } = await import(${JSON.stringify(toolBase)});
      await import(${JSON.stringify(grepHandler)});
      await import(${JSON.stringify(pipeHandler)});
      const grep = getTool("ashlr__grep");
      const pipe = getTool("ashlr__pipe");
      if (!grep || !pipe) throw new Error("handlers were not registered");
      const context = { sessionId: "pipe-grep-empty-contract", env: process.env };
      const results = [];
      for (const args of [
        { pattern: "absent-marker", cwd: ".", bypassSummary: true },
        { pattern: "absent-marker", cwd: "empty", bypassSummary: true },
        { pattern: "present-marker", cwd: ".", bypassSummary: true },
      ]) {
        const direct = await grep.handler(args, context);
        const piped = await pipe.handler({
          expr: 'return await ctx.grep(' + JSON.stringify(args) + ');', timeout_ms: 5000,
        }, context);
        results.push({ direct, piped });
      }
      console.log(JSON.stringify(results));
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
    const results = JSON.parse(stdout);
    expect(results).toHaveLength(3);
    for (const { direct, piped } of results) {
      expect(direct.isError).not.toBe(true);
      expect(piped.isError).not.toBe(true);
      expect(piped.content).toHaveLength(1);
      expect(piped.content[0].type).toBe("text");
      expect(JSON.parse(piped.content[0].text)).toBe(direct.content.map((part: { text: string }) => part.text).join(""));
    }
    for (const { piped } of results.slice(0, 2)) {
      expect(JSON.parse(piped.content[0].text)).toBe("[no matches]");
    }
    expect(JSON.parse(results[2].piped.content[0].text)).toContain("fixture.txt:1:present-marker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
