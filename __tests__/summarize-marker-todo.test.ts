import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPTS } from "../servers/_summarize";

// Avoid a mock.module replacement of the public facade in other test files.
const implementation: string = "../servers/_llm-providers/index.ts?todo-test";
const { summarizeIfLarge } = (await import(implementation)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

test("read summary retains a TODO source line with its line number", async () => {
  const originalHome = process.env.HOME;
  const originalSync = process.env.ASHLR_STATS_SYNC;
  const testHome = mkdtempSync(join(tmpdir(), "summarize-todo-"));
  process.env.HOME = testHome;
  process.env.ASHLR_STATS_SYNC = "1";
  const source = [
    "export function load() {",
    "  // TODO: validate input before loading",
    "  return 1;",
    "}",
  ].join("\n");
  const todoContract = /Preserve VERBATIM with line numbers:[\s\S]*?every (?:[A-Z-]+\|)*TODO(?:\|[A-Z-]+)* marker;/;
  let receivedSource = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    receivedSource = body.messages[1]!.content;
    const lines = receivedSource.split("\n");
    const retained = todoContract.test(body.messages[0]!.content)
      ? lines.flatMap((line, index) => /\bTODO\b/.test(line) ? [`${index + 1}: ${line}`] : [])
      : [];
    return Response.json({ choices: [{ message: { content: ["Loads a value.", ...retained].join("\n") } }] });
  }, { preconnect: originalFetch.preconnect });

  try {
    const result = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: "http://127.0.0.1:1234/v1",
    });
    expect(receivedSource).toBe(source);
    expect(result.summarized).toBe(true);
    expect(result.fellBack).toBe(false);
    expect(result.wasCached).toBe(false);
    expect(result.text).toStartWith("Loads a value.\n2:   // TODO: validate input before loading\n[ashlr summary ·");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSync === undefined) delete process.env.ASHLR_STATS_SYNC;
    else process.env.ASHLR_STATS_SYNC = originalSync;
    rmSync(testHome, { recursive: true, force: true });
  }
});
