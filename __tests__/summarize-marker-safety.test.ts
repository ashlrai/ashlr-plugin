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

const safetyContract =
  /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*SAFETY(?:\|[A-Z-]+)* marker;/;

describe("read summary SAFETY marker instruction", () => {
  test("lists SAFETY in the verbatim-preservation clause", () => {
    expect(PROMPTS.read).toMatch(safetyContract);
    const withoutIt = PROMPTS.read.replace("|SAFETY marker", " marker");
    expect(withoutIt).not.toBe(PROMPTS.read);
    expect(withoutIt).not.toMatch(safetyContract);
    for (const lookalike of ["SAFE", "SAFETY-NOTE", "SAFTEY"]) {
      const mutated = PROMPTS.read.replace("|SAFETY marker", `|${lookalike} marker`);
      expect(mutated).not.toMatch(safetyContract);
    }
  });

  test("delivers the instruction and the SAFETY line stays identifiable in the summary", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "summarize-marker-safety-"));
    process.env.HOME = testHome;
    const source = [
      "let state = 0;",
      "// SAFETY: caller holds the lock.",
      "export function bump() { return ++state; }",
    ].join("\n");
    let system: string | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          messages: Array<{ role: string; content: string }>;
        };
        system = body.messages[0].content;
        const markers = safetyContract.test(system)
          ? body.messages[1].content.split("\n").flatMap((line, index) =>
              /\bSAFETY:/.test(line) ? [`${index + 1}: ${line}`] : [],
            )
          : [];
        return Response.json({
          choices: [{ message: { content: ["Mutates state.", ...markers].join("\n") } }],
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
      expect(system).toMatch(safetyContract);
      expect(result.summarized).toBe(true);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(
        "Mutates state.\n" +
          "2: // SAFETY: caller holds the lock.\n" +
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
