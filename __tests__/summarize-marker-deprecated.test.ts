import { expect, spyOn, test } from "bun:test";
import { PROMPTS } from "../servers/_summarize";

// Avoid the module mock installed by tuner-read-callsite.test.ts.
const IMPL_SPEC: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(IMPL_SPEC)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

test("read summaries retain a DEPRECATED source line with its line number", async () => {
  const source = "export function loadV1() {\n  // DEPRECATED: use loadV2\n  return loadV2();\n}";
  const fetchStub = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    const { messages } = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const preservesDeprecated = /Preserve VERBATIM with line numbers:[\s\S]*?every (?:[A-Z-]+\|)*DEPRECATED(?:\|[A-Z-]+)* marker;/.test(messages[0]!.content);
    const lines = messages[1]!.content.split("\n");
    const index = lines.findIndex((line) => line.includes("DEPRECATED"));
    const summary = preservesDeprecated && index >= 0
      ? `Loads data.\n${index + 1}: ${lines[index]}`
      : "Loads data.";
    return Response.json({ choices: [{ message: { content: summary } }] });
  }) as typeof fetch);

  try {
    const result = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: "http://127.0.0.1:1234/v1",
    });

    expect(result.summarized).toBe(true);
    expect(result.fellBack).toBe(false);
    expect(result.text).toContain("2:   // DEPRECATED: use loadV2\n");
  } finally {
    fetchStub.mockRestore();
  }
});
