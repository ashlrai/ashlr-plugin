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

// A standalone marker has no trailing colon: `// SAFETY` or `/* SAFETY */`.
describe("read summary keeps a standalone SAFETY marker", () => {
  test("marker and its surrounding line survive in the summary", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "summarize-safety-standalone-"));
    process.env.HOME = testHome;
    const source = [
      "export function read(buf: Uint8Array, i: number) {",
      "  // SAFETY",
      "  return buf[i]!; /* SAFETY */ // index checked by caller",
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
        // Stand-in model: honours the prompt by echoing every line that
        // carries a SAFETY marker, prefixed with its line number.
        const markers = body.messages[1].content
          .split("\n")
          .flatMap((line, index) => (/\bSAFETY\b/.test(line) ? [`${index + 1}: ${line}`] : []));
        return Response.json({
          choices: [{ message: { content: ["Reads a byte.", ...markers].join("\n") } }],
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
        "Reads a byte.\n" +
          "2:   // SAFETY\n" +
          "3:   return buf[i]!; /* SAFETY */ // index checked by caller\n" +
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
