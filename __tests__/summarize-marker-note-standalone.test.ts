import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROMPTS } from "../servers/_summarize";

// Avoid the cross-file mock.module patch described in summarize-marker-note.test.ts.
const impl: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(impl)) as typeof import("../servers/_llm-providers/index.ts");

const noteContract =
  /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*NOTE(?:\|[A-Z-]+)* marker;/;

test("a standalone NOTE survives a read summary verbatim with its source line number", async () => {
  const originalHome = process.env.HOME;
  const originalSync = process.env.ASHLR_STATS_SYNC;
  const testHome = mkdtempSync(join(tmpdir(), "summarize-note-standalone-"));
  const source = [
    "export function drain(queue: string[]) {",
    "  // NOTE",
    "  while (queue.length) queue.shift();",
    "}",
  ].join("\n");
  let messages: Array<{ role: string; content: string }> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as { messages: NonNullable<typeof messages> };
      messages = body.messages;
      // Model a provider following the delivered preservation contract, with
      // no colon or explanatory text required after the marker.
      const notes = noteContract.test(body.messages[0].content)
        ? body.messages[1].content.split("\n").flatMap((line, index) =>
            /^\s*\/\/ NOTE\s*$/.test(line) ? [`${index + 1}: ${line}`] : [],
          )
        : [];
      return Response.json({
        choices: [{ message: { content: ["Drains the queue.", ...notes].join("\n") } }],
      });
    },
    { preconnect: originalFetch.preconnect },
  );

  process.env.HOME = testHome;
  // Prevent a debounced stats write from outliving the temporary home.
  process.env.ASHLR_STATS_SYNC = "1";
  try {
    const result = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: "http://127.0.0.1:12345/v1",
    });

    expect(messages).toEqual([
      { role: "system", content: PROMPTS.read },
      { role: "user", content: source },
    ]);
    expect(messages![0].content).toMatch(noteContract);
    expect(result.summarized).toBe(true);
    expect(result.wasCached).toBe(false);
    expect(result.fellBack).toBe(false);
    expect(result.text).toStartWith("Drains the queue.\n2:   // NOTE\n[ashlr summary ·");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSync === undefined) delete process.env.ASHLR_STATS_SYNC;
    else process.env.ASHLR_STATS_SYNC = originalSync;
    rmSync(testHome, { recursive: true, force: true });
  }
});
