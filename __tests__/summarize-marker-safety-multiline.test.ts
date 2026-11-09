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

// A SAFETY comment often spans several lines; the continuation lines are the
// justification and must survive next to the marker.
describe("read summary keeps a multi-line SAFETY comment", () => {
  test("marker and every continuation line survive in the summary", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "summarize-safety-multiline-"));
    process.env.HOME = testHome;
    const source = [
      "export function first(buf: Uint8Array) {",
      "  // SAFETY: buf is never empty here because",
      "  // the caller rejects zero-length input",
      "  // before this function is reached.",
      "  return buf[0]!;",
      "}",
    ].join("\n");
    let system = "";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          messages: Array<{ role: string; content: string }>;
        };
        system = body.messages[0].content;
        // Stand-in model: echoes the SAFETY line plus the contiguous comment
        // lines that follow it, each prefixed with its line number.
        const lines = body.messages[1].content.split("\n");
        const start = lines.findIndex((l) => /\bSAFETY\b/.test(l));
        const kept: string[] = [];
        for (let i = start; i >= 0 && i < lines.length && /^\s*\/\//.test(lines[i]!); i++) {
          kept.push(`${i + 1}: ${lines[i]}`);
        }
        return Response.json({
          choices: [{ message: { content: ["Returns first byte.", ...kept].join("\n") } }],
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
      expect(system).toContain("SAFETY marker");
      expect(result.summarized).toBe(true);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(
        "Returns first byte.\n" +
          "2:   // SAFETY: buf is never empty here because\n" +
          "3:   // the caller rejects zero-length input\n" +
          "4:   // before this function is reached.\n" +
          "[ashlr summary ·",
      );
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
