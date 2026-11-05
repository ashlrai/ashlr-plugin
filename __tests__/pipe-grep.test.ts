/**
 * pipe-grep.test.ts — a Unicode search term reaches ripgrep byte-exact and
 * every matching line keeps its Unicode text through `ctx.grep` and the
 * pipe.
 *
 * ashlr__grep falls back to `rg -n --no-heading --color never` emitting
 * `path:line:text` (servers/grep-server.ts, servers/_rg-text.ts); ctx.grep
 * inside an ashlr__pipe expression joins the tool's text parts verbatim and
 * the pipe JSON-serializes the result inside text content — no
 * normalization, no escaping (servers/pipe-server.ts). For multilingual
 * codebases a pattern like `café` or `日本語` must arrive as the same code
 * points the caller typed, and the matched text must come back unaltered.
 *
 * The clean spawned process covers real ripgrep matching end to end —
 * stubbed-registry coverage lives in pipe-server-grep-unicode.test.ts —
 * and asserts parity between the direct tool call and the piped expression
 * for every pattern.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const toolBase = new URL("../servers/_tool-base.ts", import.meta.url).href;
const grepHandler = new URL("../servers/grep-server-handlers.ts", import.meta.url).href;
const pipeHandler = new URL("../servers/pipe-server-handlers.ts", import.meta.url).href;

test("a Unicode search term returns matching lines with the Unicode text preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipe-grep-unicode-term-"));
  const project = join(root, "project");
  const home = join(root, "home");
  try {
    await mkdir(project, { recursive: true });
    await mkdir(home);
    // One line per script family: a precomposed é, CJK with an emoji,
    // Arabic with Eastern Arabic digits, and the decomposed é that must
    // stay distinct from the precomposed line above it.
    const fixture = [
      "café first TODO — crème brûlée",
      "日本語 second TODO 🚀",
      "مرحبا third TODO ٤٥٦",
      "cafe\u0301 fourth TODO decomposed",
      "plain fifth TODO ascii",
      "untouched line without the marker",
      "",
    ].join("\n");
    await writeFile(join(project, "fixture.txt"), fixture, "utf8");

    const cases: {
      pattern: string;
      wants?: ReadonlyArray<readonly [number, string]>;
      absent?: readonly number[];
    }[] = [
      {
        pattern: "TODO",
        wants: [
          [1, "café first TODO — crème brûlée"],
          [2, "日本語 second TODO 🚀"],
          [3, "مرحبا third TODO ٤٥٦"],
          [4, "cafe\u0301 fourth TODO decomposed"],
          [5, "plain fifth TODO ascii"],
        ],
      },
      // NFC pattern matches only the NFC line; NFD pattern only the NFD
      // line — the chain forwards the search term codepoint-exact, never
      // folded to a normalization form.
      { pattern: "café", wants: [[1, "café first TODO — crème brûlée"]], absent: [4] },
      { pattern: "cafe\u0301", wants: [[4, "cafe\u0301 fourth TODO decomposed"]], absent: [1] },
      { pattern: "日本語", wants: [[2, "日本語 second TODO 🚀"]] },
      { pattern: "🚀", wants: [[2, "日本語 second TODO 🚀"]] },
      { pattern: "مرحبا", wants: [[3, "مرحبا third TODO ٤٥٦"]] },
      // A Unicode term with no hits still yields the no-match sentinel.
      { pattern: "안녕하세요" },
    ];

    // A separate process confines the import-time pipe flag and registry,
    // and stubs fetch to prohibit network access.
    const script = `
      let fetchCalls = 0;
      globalThis.fetch = () => { fetchCalls++; throw new Error("Network access forbidden"); };
      const { getTool } = await import(${JSON.stringify(toolBase)});
      await import(${JSON.stringify(grepHandler)});
      await import(${JSON.stringify(pipeHandler)});
      const grep = getTool("ashlr__grep");
      const pipe = getTool("ashlr__pipe");
      if (!grep || !pipe) throw new Error("handlers were not registered");
      const pipeCtx = { sessionId: "pipe-grep-unicode-term", env: process.env };
      const results = [];
      for (const pattern of ${JSON.stringify(cases.map((c) => c.pattern))}) {
        const args = { pattern, cwd: ".", bypassSummary: true };
        const direct = await grep.handler(args, pipeCtx);
        const piped = await pipe.handler({
          expr: 'return await ctx.grep(' + JSON.stringify(args) + ');',
          timeout_ms: 5000,
        }, pipeCtx);
        results.push({ pattern, direct, piped });
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
    expect(results).toHaveLength(cases.length);

    for (const [i, c] of cases.entries()) {
      const { pattern, direct, piped } = results[i];
      expect(pattern).toBe(c.pattern);
      expect(direct.isError).not.toBe(true);
      expect(piped.isError).not.toBe(true);
      expect(piped.content).toHaveLength(1);
      expect(piped.content[0].type).toBe("text");

      const pipedText = JSON.parse(piped.content[0].text);
      const directText = direct.content
        .map((part: { text: string }) => part.text)
        .join("");
      // The pipe is transparent: the same bytes either way.
      expect(pipedText).toBe(directText);

      if (!c.wants) {
        expect(pipedText).toBe("[no matches]");
        continue;
      }
      const lines = pipedText.split("\n");
      for (const [n, text] of c.wants) {
        const needle = `fixture.txt:${n}:${text}`;
        expect(lines.some((line: string) => line.endsWith(needle))).toBe(true);
      }
      for (const n of c.absent ?? []) {
        expect(pipedText).not.toContain(`fixture.txt:${n}:`);
      }
      // Lines without the marker never leak into a match.
      expect(pipedText).not.toContain("untouched");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
