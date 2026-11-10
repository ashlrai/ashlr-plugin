import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROMPTS } from "../servers/_summarize";

// See summarize-marker-note.test.ts: a query-suffixed specifier avoids
// mock.module patches from other test files leaking into this import.
const IMPL_SPEC: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(IMPL_SPEC)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

// SAFETY notes appear in more than `//` comments. For each comment style the
// stand-in model echoes the marker line plus its note, and the summary must
// carry both through unchanged.
const CASES: Array<{ name: string; source: string; expected: string[] }> = [
  {
    name: "block comment",
    source: [
      "unsafe fn first(p: *const u8) -> u8 {",
      "    /* SAFETY: p is non-null and points to a live byte,",
      "       guaranteed by the caller's contract. */",
      "    *p",
      "}",
    ].join("\n"),
    expected: [
      "2:     /* SAFETY: p is non-null and points to a live byte,",
      "3:        guaranteed by the caller's contract. */",
    ],
  },
  {
    name: "hash comment",
    source: [
      "def first(buf):",
      "    # SAFETY: buf is non-empty; callers validate length.",
      "    return buf[0]",
    ].join("\n"),
    expected: ["2:     # SAFETY: buf is non-empty; callers validate length."],
  },
];

describe("read summary keeps SAFETY notes across comment styles", () => {
  for (const { name, source, expected } of CASES) {
    test(`marker and note survive in a ${name}`, async () => {
      const originalHome = process.env.HOME;
      const testHome = mkdtempSync(join(tmpdir(), "summarize-safety-styles-"));
      process.env.HOME = testHome;
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as {
            messages: Array<{ role: string; content: string }>;
          };
          const lines = body.messages[1].content.split("\n");
          const start = lines.findIndex((l) => /\bSAFETY\b/.test(l));
          // Marker line plus continuation lines up to the end of the comment.
          const kept: string[] = [];
          for (let i = start; i >= 0 && i < lines.length; i++) {
            kept.push(`${i + 1}: ${lines[i]}`);
            // Single-line styles end here; a block comment ends at `*/`.
            if (!/\/\*/.test(lines[i]!) || /\*\/\s*$/.test(lines[i]!)) break;
          }
          return Response.json({
            choices: [{ message: { content: ["Returns first element.", ...kept].join("\n") } }],
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
        expect(result.summarized).toBe(true);
        expect(result.fellBack).toBe(false);
        expect(result.text).toStartWith(["Returns first element.", ...expected, "[ashlr summary ·"].join("\n"));
      } finally {
        server.stop();
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        rmSync(testHome, { recursive: true, force: true });
      }
    });
  }
});
