import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROMPTS } from "../servers/_summarize";

// tuner-read-callsite.test.ts installs mock.module("../servers/_summarize")
// at load time, and bun propagates that patch along the re-export chain to
// the defining module — so ANY in-process import of summarizeIfLarge (via
// _summarize or _llm-providers alike) can resolve to that recorder
// depending on file order. A query-suffixed specifier registers a distinct
// module instance the mock never reaches; the code under test is identical.
const IMPL_SPEC: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(IMPL_SPEC)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

const noteContract =
  /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*NOTE(?:\|[A-Z-]+)* marker;/;

// The NOTE line under test mixes the Unicode shapes most likely to expose
// byte-vs-char mishandling: accented Latin, CJK, a combining mark
// (e + U+0301), and an astral emoji that spans a UTF-16 surrogate pair.
const UNICODE_NOTE = "// NOTE: café résumé — naïve テキスト é 🚀";

function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function withTempHome(run: () => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;
  const testHome = mkdtempSync(join(tmpdir(), "summarize-note-unicode-"));
  process.env.HOME = testHome;
  // Force synchronous stats writes so a debounced flush can't outlive the
  // temp dir (same trick as _summarize.test.ts).
  const originalStatsSync = process.env.ASHLR_STATS_SYNC;
  process.env.ASHLR_STATS_SYNC = "1";
  return run().finally(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStatsSync === undefined) delete process.env.ASHLR_STATS_SYNC;
    else process.env.ASHLR_STATS_SYNC = originalStatsSync;
    rmSync(testHome, { recursive: true, force: true });
  });
}

/** Stub provider that echoes NOTE lines from the source it actually received. */
function startNoteEcho(): { url: string; calls: () => number; stop: () => void } {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      calls++;
      const body = (await request.json()) as {
        messages: Array<{ role: string; content: string }>;
      };
      const notes = body.messages[1].content.split("\n").flatMap((line, index) =>
        /\bNOTE:/.test(line) ? [`${index + 1}: ${line}`] : [],
      );
      return Response.json({
        choices: [{ message: { content: ["Source summarized.", ...notes].join("\n") } }],
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    calls: () => calls,
    stop: () => server.stop(),
  };
}

describe("read summary with a NOTE marker beside Unicode text", () => {
  test("provider round-trip preserves the marker and its adjacent Unicode verbatim", async () => {
    await withTempHome(async () => {
      const source = [
        "export function greet(name: string) {",
        `  ${UNICODE_NOTE}`,
        "  return `hello ${name}`;",
        "}",
      ].join("\n");

      let messages: Array<{ role: string; content: string }> | undefined;
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as {
            messages: Array<{ role: string; content: string }>;
          };
          messages = body.messages;
          const notes = body.messages[1].content.split("\n").flatMap((line, index) =>
            /\bNOTE:/.test(line) ? [`${index + 1}: ${line}`] : [],
          );
          return Response.json({
            choices: [{ message: { content: ["Greets by name.", ...notes].join("\n") } }],
          });
        },
      });

      try {
        const result = await summarizeIfLarge(source, {
          toolName: "ashlr__read",
          systemPrompt: PROMPTS.read,
          thresholdBytes: 1,
          endpointOverride: `http://127.0.0.1:${server.port}/v1`,
        });

        // Transport: the provider received the Unicode source verbatim and
        // the NOTE preservation contract was actually delivered.
        expect(messages).toEqual([
          { role: "system", content: PROMPTS.read },
          { role: "user", content: source },
        ]);
        expect(messages![0].content).toMatch(noteContract);

        // The summary keeps the marker AND the adjacent Unicode text.
        expect(result.summarized).toBe(true);
        expect(result.wasCached).toBe(false);
        expect(result.fellBack).toBe(false);
        expect(result.text).toContain(UNICODE_NOTE);
        expect(result.text).toContain(`2:   ${UNICODE_NOTE}`);
        // Byte accounting stays UTF-8 aware for astral characters, and no
        // surrogate pair was split along the way.
        expect(result.outputBytes).toBe(Buffer.byteLength(result.text, "utf-8"));
        expect(hasUnpairedSurrogate(result.text)).toBe(false);
      } finally {
        server.stop();
      }
    });
  });

  test("below the threshold, the NOTE line with Unicode returns unchanged", async () => {
    await withTempHome(async () => {
      const source = `${UNICODE_NOTE}\nexport const version = "1.0.0";\n`;
      const result = await summarizeIfLarge(source, {
        toolName: "ashlr__read",
        systemPrompt: PROMPTS.read,
        thresholdBytes: Buffer.byteLength(source, "utf-8"),
        providerOverride: "off",
      });

      expect(result).toEqual({
        text: source,
        summarized: false,
        wasCached: false,
        fellBack: false,
        outputBytes: Buffer.byteLength(source, "utf-8"),
      });
    });
  });

  test("threshold is measured in UTF-8 bytes, not UTF-16 units", async () => {
    await withTempHome(async () => {
      // 10 ASCII chars + 57 CJK chars = 67 code units but 181 UTF-8 bytes.
      const source = "// NOTE: " + "\u8a9e".repeat(57) + "\n";
      expect(source.length).toBe(67);
      expect(Buffer.byteLength(source, "utf-8")).toBe(181);

      const stub = startNoteEcho();
      try {
        const result = await summarizeIfLarge(source, {
          toolName: "ashlr__read",
          systemPrompt: PROMPTS.read,
          // Between the two measures: a char-unit threshold would skip
          // summarizing (67 <= 100); the byte threshold must trigger it.
          thresholdBytes: 100,
          endpointOverride: stub.url,
        });

        expect(stub.calls()).toBe(1);
        expect(result.summarized).toBe(true);
        expect(result.fellBack).toBe(false);
        expect(result.text).toContain(`1: ${source.trimEnd()}`);
      } finally {
        stub.stop();
      }
    });
  });

  test("cached path: a second call keeps the marker and Unicode from disk", async () => {
    await withTempHome(async () => {
      const source = `// header\n${UNICODE_NOTE}\n${"const pad = 0;\n".repeat(120)}`;
      const stub = startNoteEcho();
      const base = {
        toolName: "ashlr__read",
        systemPrompt: PROMPTS.read,
        thresholdBytes: 1,
      };

      const first = await summarizeIfLarge(source, {
        ...base,
        endpointOverride: stub.url,
      });
      expect(first.wasCached).toBe(false);
      expect(stub.calls()).toBe(1);
      stub.stop();

      const second = await summarizeIfLarge(source, {
        ...base,
        endpointOverride: "http://127.0.0.1:1/v1", // unreachable — cache must serve
      });
      expect(second.summarized).toBe(true);
      expect(second.wasCached).toBe(true);
      expect(second.fellBack).toBe(false);
      expect(second.text).toContain(`2: ${UNICODE_NOTE}`);
      expect(hasUnpairedSurrogate(second.text)).toBe(false);
    });
  });

  test("snipCompact fallback keeps NOTE+Unicode at the edges and never splits a surrogate pair", async () => {
    await withTempHome(async () => {
      const head = `// file: i18n.ts\n${UNICODE_NOTE}\n`;
      const tail = `\n${UNICODE_NOTE}\n`;
      // An astral emoji whose surrogate pair straddles the 800-unit head
      // cut (high at 799, low at 800) and another straddling the tail cut.
      // The fix in snipFallback elides them whole instead of emitting half.
      const BOUNDARY_EMOJI = "\u{1F30A}"; // 🌊
      const headPad = "x".repeat(799 - head.length);
      const tailPad = "y".repeat(799 - tail.length);
      const middle = `${"m".repeat(600)}\n`;
      const source = head + headPad + BOUNDARY_EMOJI + middle + BOUNDARY_EMOJI + tailPad + tail;
      expect(source.length).toBeGreaterThan(2000);
      expect(source.charCodeAt(799)).toBe(0xd83c); // 🌊 high surrogate at the head cut
      expect(source.charCodeAt(source.length - 800)).toBe(0xdf0a); // 🌊 low surrogate at the tail cut

      const result = await summarizeIfLarge(source, {
        toolName: "ashlr__read",
        systemPrompt: PROMPTS.read,
        thresholdBytes: 1,
        providerOverride: "off",
      });

      expect(result.summarized).toBe(false);
      expect(result.fellBack).toBe(true);
      expect(result.text).toMatch(/\[\.\.\. \d+ bytes elided \.\.\.\]/);
      expect(result.text).toContain("no LLM provider");
      // Both retained edges still carry the marker with its Unicode text.
      expect(result.text.indexOf(UNICODE_NOTE)).not.toBe(result.text.lastIndexOf(UNICODE_NOTE));
      // The boundary-straddling emoji was elided whole — never half-emitted.
      expect(result.text).not.toContain(BOUNDARY_EMOJI);
      expect(hasUnpairedSurrogate(result.text)).toBe(false);
      // Non-vacuity: the middle really was cut.
      expect(result.text).not.toContain("mmmm");
    });
  });
});
