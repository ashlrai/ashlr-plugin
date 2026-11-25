import { expect, spyOn, test } from "bun:test";
import { PROMPTS } from "../servers/_summarize";

// Avoid the module mock installed by tuner-read-callsite.test.ts.
const IMPL_SPEC: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(IMPL_SPEC)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

test.each(["XXX: handle stale data", "XXX"])("read summaries retain a numbered source line with %s", async (marker) => {
  const source = `export function load() {\n  // ${marker}\n  return 1;\n}`;
  const contract = /Preserve VERBATIM with line numbers:[^;]*;\s*every (?:[A-Z-]+\|)*XXX(?:\|[A-Z-]+)* marker;/;
  let receivedSource = "";
  let receivedPrompt = "";
  const fetchStub = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    const { messages } = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    receivedPrompt = messages[0]!.content;
    receivedSource = messages[1]!.content;
    const lines = receivedSource.split("\n");
    const index = lines.findIndex((line) => line.trim() === `// ${marker}`);
    const summary = contract.test(receivedPrompt) && index >= 0
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

    expect(receivedPrompt).toMatch(contract);
    expect(receivedSource).toBe(source);
    expect(result.summarized).toBe(true);
    expect(result.wasCached).toBe(false);
    expect(result.fellBack).toBe(false);
    expect(result.text).toStartWith(`Loads data.\n2:   // ${marker}\n[ashlr summary ·`);
  } finally {
    fetchStub.mockRestore();
  }
});
