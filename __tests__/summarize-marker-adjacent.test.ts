import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPTS } from "../servers/_summarize";

// Isolate the implementation from facade mocks installed by other tests.
const implementation: string = "../servers/_llm-providers/index.ts?adjacent-markers";
const { summarizeIfLarge } = (await import(implementation)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

test("read summaries retain adjacent TODO and FIXME lines, including from cache", async () => {
  const originalHome = process.env.HOME;
  const testHome = mkdtempSync(join(tmpdir(), "summarize-adjacent-"));
  process.env.HOME = testHome;
  const source = [
    "export function load() {",
    "  // TODO: validate the input",
    "  // FIXME: handle an empty result",
    "  return 1;",
    "}",
  ].join("\n");
  let calls = 0;
  let messages: Array<{ role: string; content: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls++;
      ({ messages } = JSON.parse(String(init?.body)) as { messages: typeof messages });
      const clause = messages[0]!.content.match(
        /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)*every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/,
      );
      const markers = clause?.[1]?.split("|") ?? [];
      // Simulate a provider following the delivered preservation instruction.
      const lines = messages[1]!.content.split("\n").flatMap((line, index) =>
        markers.some((marker) => line.includes(`${marker}:`)) ? [`${index + 1}: ${line}`] : [],
      );
      return Response.json({ choices: [{ message: { content: ["Loads a value.", ...lines].join("\n") } }] });
    },
    { preconnect: originalFetch.preconnect },
  );

  try {
    const opts = {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: "http://127.0.0.1:1234/v1",
    };
    const first = await summarizeIfLarge(source, opts);
    const cached = await summarizeIfLarge(source, opts);
    expect(messages).toEqual([
      { role: "system", content: PROMPTS.read },
      { role: "user", content: source },
    ]);
    expect(calls).toBe(1);
    expect(first.summarized).toBe(true);
    expect(first.fellBack).toBe(false);
    expect(first.wasCached).toBe(false);
    expect(cached.wasCached).toBe(true);
    for (const result of [first, cached]) {
      expect(result.text).toContain(
        "2:   // TODO: validate the input\n3:   // FIXME: handle an empty result",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  }
});
