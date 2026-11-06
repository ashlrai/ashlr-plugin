/**
 * pipe-server-grep-unicode.test.ts — verifies that `ctx.grep` inside an
 * ashlr__pipe expression returns grep text with Unicode characters and line
 * boundaries preserved exactly.
 *
 * The pipe concatenates the grep tool's text content parts with join("") and
 * JSON-serializes the expression's return value inside text content — no
 * normalization, no escaping, no newline rewriting (servers/pipe-server.ts).
 * That contract matters for multilingual codebases: a grep result naming
 * `café.ts`, a `日本語` comment, or an emoji must reach the model byte-for-
 * byte, and `out.split("\n")` inside an expression must see the same lines
 * the tool emitted.
 *
 * The in-process tests stub ashlr__grep through the registry; the final test
 * spawns a clean process with the real handler so ripgrep's UTF-8 output is
 * covered end to end.
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
  type ToolTextContent,
} from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

const toolBase = new URL("../servers/_tool-base.ts", import.meta.url).href;
const grepHandler = new URL("../servers/grep-server-handlers.ts", import.meta.url).href;
const pipeHandler = new URL("../servers/pipe-server-handlers.ts", import.meta.url).href;

const ctx: ToolCallContext = { sessionId: "pipe-server-grep-unicode", env: {} };

async function withGrepContent(
  content: ToolTextContent[],
  run: (calls: Record<string, unknown>[]) => Promise<void>,
) {
  const registry = __snapshotRegistryForTests();
  const calls: Record<string, unknown>[] = [];
  try {
    registerTool({
      name: "ashlr__grep",
      description: "fixture",
      inputSchema: {},
      handler: async (args) => {
        calls.push(args);
        return { content };
      },
    });
    await run(calls);
  } finally {
    __restoreRegistryForTests(registry);
  }
}

test("ctx.grep returns Unicode grep text verbatim with line boundaries intact", async () => {
  // One line per script family plus the status shapes grep actually emits —
  // including the middle dot used by the confidence badge, a U+2028 line
  // separator that must stay inside its line, and a U+FEFF (BOM) that is
  // content, not metadata. An interior blank line and a trailing newline
  // pin the boundaries.
  const grepText = [
    "src/café/naïve.ts:1:TODO crème brûlée — déjà vu",
    "src/日本語/ログイン.ts:2:TODO ログイン画面を直す",
    "src/مرحبا.ts:3:TODO مرحبا بالعالم ٤٥٦",
    "src/emoji.ts:4:TODO ship it 🚀 and the 👨\u200D👩\u200D👧 🇫🇷",
    "[ashlr confidence: low · bypassSummary:true to recover fidelity]",
    "src/sep.ts:9:TODO a\u2028b stays inside its own line",
    "",
    "src/last.ts:7:TODO ends the list\uFEFF",
    "",
  ].join("\n");

  await withGrepContent([{ type: "text", text: grepText }], async (calls) => {
    const args = { pattern: "TODO", cwd: ".", bypassSummary: true };
    const result = await ashlrPipe(
      {
        expr:
          "return await ctx.grep({pattern: 'TODO', cwd: '.', bypassSummary: true});",
      },
      ctx,
    );

    // The pipe JSON-serializes the returned string inside text content.
    expect(result.text).toBe(JSON.stringify(grepText));
    expect(JSON.parse(result.text)).toBe(grepText);
    // JSON.stringify does not escape non-ASCII: the serialized payload
    // carries the characters literally.
    expect(result.text).toContain("日本語");
    expect(result.text).toContain("🚀");

    // Accounting counts UTF-8 bytes, not UTF-16 code units — for this text
    // the byte length is strictly larger than string length.
    expect(result.rawIntermediate).toBe(Buffer.byteLength(grepText, "utf8"));
    expect(result.rawIntermediate).toBeGreaterThan(grepText.length);

    // Inside the expression the value really is a string whose "\n" splits
    // reproduce exactly the lines the tool emitted — including the blank
    // line and the trailing empty element.
    const inner = await ashlrPipe(
      {
        expr:
          "const out = await ctx.grep({pattern:'TODO',cwd:'.',bypassSummary:true});" +
          " return [typeof out, out.split('\\n')];",
      },
      ctx,
    );
    expect(JSON.parse(inner.text)).toEqual(["string", grepText.split("\n")]);

    expect(calls).toEqual([args, args]);
  });
});

test("ctx.grep joins multiple content parts verbatim, even across a surrogate pair", async () => {
  // Parts are concatenated with join(""). Splitting an emoji's surrogate
  // pair and a combining mark across part boundaries must still reassemble
  // the characters, and a CRLF split across parts stays CRLF.
  const parts: ToolTextContent[] = [
    { type: "text", text: "x.ts:1:TODO \uD83D" },
    { type: "text", text: "\uDE80 done\ny.ts:2:TODO cafe" },
    { type: "text", text: "\u0301\nz.ts:3:TODO line\r" },
    { type: "text", text: "\nnext.ts:4:TODO\n" },
  ];
  const joined =
    "x.ts:1:TODO 🚀 done\ny.ts:2:TODO cafe\u0301\nz.ts:3:TODO line\r\nnext.ts:4:TODO\n";

  await withGrepContent(parts, async (calls) => {
    const result = await ashlrPipe(
      { expr: "return await ctx.grep({pattern:'TODO'});" },
      ctx,
    );
    expect(JSON.parse(result.text)).toBe(joined);

    const lines = JSON.parse(result.text).split("\n");
    expect(lines).toHaveLength(5);
    // The emoji reassembled across the part boundary.
    expect(lines[0]).toBe("x.ts:1:TODO 🚀 done");
    // The combining acute landed on the 'e' from the previous part.
    expect(lines[1]).toBe("y.ts:2:TODO cafe\u0301");
    // No newline normalization: the CRLF survives as CRLF.
    expect(lines[2]).toBe("z.ts:3:TODO line\r");
    expect(lines[3]).toBe("next.ts:4:TODO");
    expect(lines[4]).toBe("");

    expect(calls).toEqual([{ pattern: "TODO" }]);
  });
});

test("ctx.grep does not normalize — precomposed and decomposed forms stay distinct", async () => {
  // 'café' as U+00E9 and as 'e' + U+0301 are different byte sequences; the
  // pipe must return whichever the tool emitted, never NFC-folded.
  const decomposed = "cafe\u0301.ts:1:TODO nai\u0308ve\n";
  const precomposed = "café.ts:2:TODO café\n";
  const grepText = decomposed + precomposed;

  await withGrepContent([{ type: "text", text: grepText }], async (calls) => {
    const result = await ashlrPipe(
      { expr: "return await ctx.grep({pattern:'TODO'});" },
      ctx,
    );
    const out = JSON.parse(result.text);
    expect(out).toBe(grepText);
    expect(out).toContain("cafe\u0301.ts:1:");
    expect(out).toContain("café.ts:2:");
    // The decomposed line really survived: folding to NFC would change it.
    expect(out.normalize("NFC")).not.toBe(out);
    expect(out.normalize("NFC")).toContain("café.ts:1:");

    // The same holds inside the expression itself.
    const inner = await ashlrPipe(
      {
        expr:
          "const o = await ctx.grep({pattern:'TODO'});" +
          " return [o.includes('cafe\u0301.ts'), o === o.normalize('NFC')];",
      },
      ctx,
    );
    expect(JSON.parse(inner.text)).toEqual([true, false]);

    expect(calls).toEqual([{ pattern: "TODO" }, { pattern: "TODO" }]);
  });
});

test("ctx.grep forwards a Unicode pattern and cwd to the handler verbatim", async () => {
  const args = { pattern: "café|日本語", cwd: "my projéct" };
  const grepText = "my projéct/日本語.ts:1:café match\n";

  await withGrepContent([{ type: "text", text: grepText }], async (calls) => {
    const result = await ashlrPipe(
      { expr: `return await ctx.grep(${JSON.stringify(args)});` },
      ctx,
    );
    expect(JSON.parse(result.text)).toBe(grepText);
    // Args reach ashlr__grep with their code points intact.
    expect(calls).toEqual([args]);
    expect(calls[0].pattern).toBe("café|日本語");
    expect(calls[0].cwd).toBe("my projéct");
  });
});

test("a max_output_bytes cut inside a multibyte character stays decodable", async () => {
  // The pipe truncates the serialized return value at a byte boundary
  // (Buffer.slice). A cut mid-codepoint yields \uFFFD rather than throwing or
  // emitting malformed UTF-8 — pin that contract.
  const grepText = "a.ts:1:TODO café\n";
  const serialized = JSON.stringify(grepText);
  const byteOffset = Buffer.byteLength(serialized.slice(0, serialized.indexOf("é")), "utf8");
  const max_output_bytes = byteOffset + 1; // lands inside the 2-byte 'é'

  await withGrepContent([{ type: "text", text: grepText }], async () => {
    const result = await ashlrPipe(
      { expr: "return await ctx.grep({pattern:'TODO'});", max_output_bytes },
      ctx,
    );
    expect(result.text).toEndWith("\n[ashlr__pipe: output truncated]");
    expect(result.text).toContain("\uFFFD");
    expect(result.text).not.toContain("café");
  });
});

test("the real grep handler returns Unicode rg output to the pipe intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipe-grep-unicode-"));
  const project = join(root, "project");
  const home = join(root, "home");
  try {
    await mkdir(project, { recursive: true });
    await mkdir(home);
    const fixture = [
      "café first TODO — crème brûlée",
      "日本語 second TODO 🚀",
      "مرحبا third TODO ٤٥٦",
      "cafe\u0301 fourth TODO decomposed",
      "untouched line without the marker",
      "",
    ].join("\n");
    await writeFile(join(project, "fixture.txt"), fixture, "utf8");

    // A separate process confines the import-time pipe flag and registry,
    // and stubs fetch to prohibit network access.
    const script = `
      let fetchCalls = 0;
      globalThis.fetch = () => { fetchCalls++; throw new Error("Network access forbidden"); };
      const { getTool } = await import(${JSON.stringify(toolBase)});
      await import(${JSON.stringify(grepHandler)});
      await import(${JSON.stringify(pipeHandler)});
      const pipe = getTool("ashlr__pipe");
      if (!pipe) throw new Error("pipe handler was not registered");
      const pipeCtx = { sessionId: "pipe-grep-unicode-test", env: process.env };
      const call = (args) => pipe.handler(
        { expr: 'return await ctx.grep(' + JSON.stringify(args) + ');', timeout_ms: 5000 },
        pipeCtx,
      );
      const unicode = await call({ pattern: "TODO", cwd: ".", bypassSummary: true });
      const unicodePattern = await call({ pattern: "café", cwd: ".", bypassSummary: true });
      console.log(JSON.stringify({ unicode, unicodePattern, fetchCalls }));
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
    const { unicode, unicodePattern, fetchCalls } = JSON.parse(stdout);
    expect(fetchCalls).toBe(0);

    // bypassSummary returns the rg text as-is; every match is a complete
    // `path:line:text` line and the Unicode survives the UTF-8 decode, the
    // pipe's join, and the JSON round trip.
    expect(unicode.isError).not.toBe(true);
    const out = JSON.parse(unicode.content[0].text);
    const lines = out.split("\n");
    const want = [
      [1, "café first TODO — crème brûlée"],
      [2, "日本語 second TODO 🚀"],
      [3, "مرحبا third TODO ٤٥٦"],
      [4, "cafe\u0301 fourth TODO decomposed"],
    ] as const;
    for (const [n, text] of want) {
      const needle = `fixture.txt:${n}:${text}`;
      expect(lines.some((line: string) => line.endsWith(needle))).toBe(true);
    }
    expect(out).not.toContain("untouched");

    // A Unicode pattern reaches ripgrep byte-exact: precomposed 'café'
    // matches line 1 but not the decomposed 'cafe\u0301' on line 4.
    expect(unicodePattern.isError).not.toBe(true);
    const patternLines = JSON.parse(unicodePattern.content[0].text).split("\n");
    expect(
      patternLines.some((line: string) => line.endsWith(`fixture.txt:1:${want[0][1]}`)),
    ).toBe(true);
    expect(patternLines.some((line: string) => line.includes("decomposed"))).toBe(false);
    expect(patternLines.some((line: string) => line.includes("second TODO"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
