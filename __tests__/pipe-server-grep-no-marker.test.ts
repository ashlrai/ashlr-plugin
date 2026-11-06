/**
 * pipe-server-grep-no-marker.test.ts — the ctx.grep helper registered through
 * servers/pipe-server-handlers.ts returns the documented no-match result for
 * a temporary fixture whose names carry the requested marker but whose file
 * contents do not.
 *
 * The fixture is the false-match trap: `TODO.txt` and a `TODO/` directory
 * both contain the marker in their names while no file content does. A grep
 * that reported filenames instead of content matches would leak a
 * `path:line:`-shaped line — or the marker-named file itself — into the
 * result. docs/pipe-grep-return.md documents `[no matches]` as the sentinel
 * emitted when nothing is found and `[]` as the output of its empty-array
 * idiom; this test pins both against the real ashlr__grep handler.
 *
 * Registration is gated on ASHLR_PIPE_ENABLE=1 at import time, so the case
 * runs in a spawned process like pipe-grep-empty-result.test.ts — setting
 * the flag in-process would leak it into sibling test files that import the
 * same module graph.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const toolBase = new URL("../servers/_tool-base.ts", import.meta.url).href;
const grepHandler = new URL("../servers/grep-server-handlers.ts", import.meta.url).href;
const pipeHandler = new URL("../servers/pipe-server-handlers.ts", import.meta.url).href;

test("ctx.grep returns the documented no-match result for a fixture without the marker", async () => {
  const guide = await readFile(new URL("../docs/pipe-grep-return.md", import.meta.url), "utf8");
  // The sentinel documented for "nothing is found".
  expect(guide).toContain("`[no matches]` | The sentinel emitted when nothing is found");
  // The documented empty-array idiom for no matches (greps for TODO).
  const section = guide.split("### Return an empty array for no matches\n")[1]?.split("\n### ")[0];
  const request = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!request) throw new Error("Missing documented empty-array grep request");
  const { expr } = JSON.parse(request) as { expr: string };
  expect(expr).toContain("pattern: 'TODO'");

  const root = await mkdtemp(join(tmpdir(), "pipe-grep-no-marker-"));
  const project = join(root, "project");
  const home = join(root, "home");
  try {
    // The requested marker "TODO" appears only in names — a file, a
    // directory — never in file contents. notes.txt holds a spaced
    // near-miss plus a real needle for the positive control.
    await mkdir(join(project, "TODO"), { recursive: true });
    await mkdir(home);
    await writeFile(join(project, "TODO.txt"), "alpha-needle first line\n");
    await writeFile(join(project, "TODO", "inner.txt"), "alpha-needle nested line\n");
    await writeFile(join(project, "notes.txt"), "TO DO spaced near-miss\nalpha-needle third line\n");

    // Guard the fixture premise: the marker is absent from every file's
    // contents and present in the tree's names, so a no-match result is
    // not vacuous.
    const fixtureFiles = ["TODO.txt", join("TODO", "inner.txt"), "notes.txt"];
    for (const rel of fixtureFiles) {
      expect(await readFile(join(project, rel), "utf8")).not.toContain("TODO");
    }
    expect(fixtureFiles.some((rel) => rel.includes("TODO"))).toBe(true);

    // A separate process confines the import-time pipe flag and registry
    // and lets the fetch trap prove the search stays offline.
    const script = `
      let fetchCalls = 0;
      globalThis.fetch = () => { fetchCalls++; throw new Error("Network access forbidden"); };
      const { getTool } = await import(${JSON.stringify(toolBase)});
      await import(${JSON.stringify(grepHandler)});
      await import(${JSON.stringify(pipeHandler)});
      const pipe = getTool("ashlr__pipe");
      if (!pipe) throw new Error("ashlr__pipe was not registered under ASHLR_PIPE_ENABLE=1");
      const grep = getTool("ashlr__grep");
      if (!grep) throw new Error("ashlr__grep was not registered");
      const ctx = { sessionId: "pipe-grep-no-marker-test", env: process.env };
      const grepArgs = { pattern: "TODO", cwd: ".", bypassSummary: true };
      const direct = await grep.handler(grepArgs, ctx);
      const piped = await pipe.handler(
        { expr: "return await ctx.grep(" + JSON.stringify(grepArgs) + ");", timeout_ms: 5000 },
        ctx,
      );
      const filtered = await pipe.handler(
        { expr: ${JSON.stringify(expr)}, timeout_ms: 5000 },
        ctx,
      );
      const present = await pipe.handler(
        { expr: "return await ctx.grep({pattern:'alpha-needle',cwd:'.',bypassSummary:true});", timeout_ms: 5000 },
        ctx,
      );
      console.log(JSON.stringify({ direct, piped, filtered, present, fetchCalls }));
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
    const { direct, piped, filtered, present, fetchCalls } = JSON.parse(stdout);
    expect(fetchCalls).toBe(0);

    // The real grep tool emits the documented no-match sentinel verbatim.
    expect(direct.isError).not.toBe(true);
    expect(direct.content).toEqual([{ type: "text", text: "[no matches]" }]);

    // ctx.grep inside the pipe returns that identical string — the existing
    // documented no-match result — serialized as a JSON string.
    expect(piped.isError).not.toBe(true);
    expect(piped.content).toHaveLength(1);
    expect(piped.content[0].type).toBe("text");
    const pipedValue = JSON.parse(piped.content[0].text);
    expect(pipedValue).toBe("[no matches]");
    expect(piped.content[0].text).toBe(JSON.stringify(direct.content[0].text));

    // No false match: no path:line:-shaped line survives, and none of the
    // marker-named fixture entries leak into the result.
    expect(pipedValue.split("\n").filter((l: string) => /:\d+:/.test(l))).toEqual([]);
    for (const name of fixtureFiles) {
      expect(pipedValue).not.toContain(name);
    }

    // The documented empty-array idiom reports [] over the same fixture —
    // again no false match from names carrying the marker.
    expect(filtered.isError).not.toBe(true);
    expect(JSON.parse(filtered.content[0].text)).toEqual([]);

    // Positive control: real content matches still surface through the same
    // path, so the empty result is a genuine no-match, not a broken search.
    expect(present.isError).not.toBe(true);
    const presentLines = (JSON.parse(present.content[0].text) as string)
      .split("\n")
      .filter((l: string) => /:\d+:/.test(l));
    expect(presentLines).toHaveLength(3);
    for (const fragment of ["TODO.txt:1:", "inner.txt:1:", "notes.txt:2:"]) {
      expect(presentLines.some((l: string) => l.includes(fragment))).toBe(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
