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
const safetyContract =
  /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*SAFETY(?:\|[A-Z-]+)* marker;/;

describe("read summary NOTE marker instruction", () => {
  test("lists NOTE once among the markers preserved verbatim with line numbers", () => {
    const clause = PROMPTS.read.match(
      /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)*every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/,
    );
    expect(clause).not.toBeNull();
    const markers = clause![1].split("|");
    expect(markers.filter((marker) => marker === "NOTE")).toHaveLength(1);
    expect(PROMPTS.read).toMatch(noteContract);

    // A mention outside the preservation clause must not satisfy the contract.
    const withoutNote = PROMPTS.read.replace("|NOTE|", "|");
    expect(withoutNote).not.toBe(PROMPTS.read);
    expect(withoutNote).not.toMatch(noteContract);
    expect(withoutNote).toMatch(safetyContract);
    expect(`${withoutNote} Mention every NOTE marker;`).not.toMatch(noteContract);
    for (const lookalike of ["NOTED", "NOTES", "NOTEBOOK", "FOOTNOTE", "NOTE-CHECK"]) {
      const mutated = PROMPTS.read.replace(/\bNOTE\b/, lookalike);
      expect(mutated).not.toBe(PROMPTS.read);
      expect(mutated).not.toMatch(noteContract);
    }
    expect(PROMPTS.read.replace("VERBATIM", "")).not.toMatch(noteContract);
    expect(PROMPTS.read.replace("with line numbers", "")).not.toMatch(noteContract);
  });

  test("delivers the NOTE instruction to the provider and returns numbered NOTE lines", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "summarize-marker-note-"));
    process.env.HOME = testHome;
    const source = [
      "export function drain(queue: string[]) {",
      "  // NOTE: the queue is drained in FIFO order.",
      "  while (queue.length) queue.shift();",
      "  return queue.length; // NOTE: always zero after drain",
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
        // Model a provider that follows the preservation clause only when
        // the delivered prompt actually carries the NOTE contract, using
        // the source it received.
        const notes = noteContract.test(body.messages[0].content)
          ? body.messages[1].content.split("\n").flatMap((line, index) =>
              /\bNOTE:/.test(line) ? [`${index + 1}: ${line}`] : [],
            )
          : [];
        return Response.json({
          choices: [{ message: { content: ["Drains the queue.", ...notes].join("\n") } }],
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

      expect(messages).toEqual([
        { role: "system", content: PROMPTS.read },
        { role: "user", content: source },
      ]);
      expect(messages![0].content).toMatch(noteContract);
      expect(result.summarized).toBe(true);
      expect(result.wasCached).toBe(false);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(
        "Drains the queue.\n" +
          "2:   // NOTE: the queue is drained in FIFO order.\n" +
          "4:   return queue.length; // NOTE: always zero after drain\n" +
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
