import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROMPTS } from "../servers/_summarize";

// Query-suffixed specifier: avoids mock.module patches from other test files
// (see summarize-marker-note.test.ts for the full explanation).
const IMPL_SPEC: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(IMPL_SPEC)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

const warningContract =
  /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*WARNING(?:\|[A-Z-]+)* marker;/;

describe("read summary WARNING marker beside ordinary comments", () => {
  test("keeps the WARNING line, with its line number, and drops no unrelated comment into its place", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "summarize-marker-warning-"));
    process.env.HOME = testHome;
    const source = [
      "// Helpers for the cache layer.",
      "export function purge(dir: string) {",
      "  // Walk the directory tree first.",
      "  // WARNING: deletes every file under dir, no undo",
      "  // Returns the number of removed files.",
      "  return removeAll(dir);",
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
        // Provider that honours the preservation clause: it emits only the
        // marker lines (verbatim, numbered), never ordinary comments.
        const kept = warningContract.test(system)
          ? body.messages[1].content.split("\n").flatMap((line, i) =>
              /\bWARNING:/.test(line) ? [`${i + 1}: ${line}`] : [],
            )
          : [];
        return Response.json({
          choices: [{ message: { content: ["Purges a cache directory.", ...kept].join("\n") } }],
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

      expect(system).toMatch(warningContract);
      expect(result.summarized).toBe(true);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(
        "Purges a cache directory.\n" +
          "4:   // WARNING: deletes every file under dir, no undo\n" +
          "[ashlr summary ·",
      );
      for (const ordinary of [
        "Helpers for the cache layer",
        "Walk the directory tree",
        "Returns the number of removed files",
      ]) {
        expect(result.text).not.toContain(ordinary);
      }
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("contract rejects a prompt where WARNING sits outside the preservation clause", () => {
    expect(PROMPTS.read).toMatch(warningContract);
    const without = PROMPTS.read.replace("|WARNING|", "|");
    expect(without).not.toMatch(warningContract);
    expect(`${without} Mention every WARNING marker;`).not.toMatch(warningContract);
  });
});
