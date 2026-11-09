import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPTS } from "../servers/_summarize";

// Isolate the implementation from facade mocks installed by other tests.
const implementation: string = "../servers/_llm-providers/index.ts?hack-following-code";
const { summarizeIfLarge } = (await import(implementation)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

test("read summary keeps a HACK comment and does not mark the code after it", async () => {
  const originalHome = process.env.HOME;
  const testHome = mkdtempSync(join(tmpdir(), "summarize-hack-"));
  process.env.HOME = testHome;
  const source = [
    "export function total(items: number[]) {",
    "  // HACK: round early to dodge the float drift",
    "  const sum = items.reduce((a, b) => a + b, 0);",
    "  return Math.round(sum);",
    "}",
  ].join("\n");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const { messages } = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const clause = messages[0]!.content.match(/every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/);
      const markers = clause?.[1]?.split("|") ?? [];
      // Simulate a provider that follows the delivered instruction: only the
      // comment line is quoted, with its own line number.
      const lines = messages[1]!.content.split("\n").flatMap((line, index) =>
        markers.some((marker) => line.includes(`${marker}:`)) ? [`${index + 1}: ${line}`] : [],
      );
      return Response.json({ choices: [{ message: { content: ["Sums items.", ...lines].join("\n") } }] });
    },
    { preconnect: originalFetch.preconnect },
  );

  try {
    const result = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: "http://127.0.0.1:1234/v1",
    });
    expect(result.summarized).toBe(true);
    expect(result.text).toContain("2:   // HACK: round early to dodge the float drift");
    // The code on lines 3-4 is ordinary: no marker line, no HACK text on it.
    expect(result.text).not.toMatch(/^[34]:/m);
    expect(result.text).not.toContain("reduce");
    expect(result.text.match(/HACK/g)).toHaveLength(1);
    // The prompt itself forbids inventing markers the source lacks.
    expect(PROMPTS.read).toContain("Do not invent markers that are absent from the source.");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  }
});
