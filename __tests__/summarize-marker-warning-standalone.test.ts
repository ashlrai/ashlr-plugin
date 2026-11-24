import { expect, test } from "bun:test";
import { PROMPTS } from "../servers/_summarize";

// Avoid the cross-file mock.module patch described in summarize-marker-note.test.ts.
const impl: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(impl)) as typeof import("../servers/_llm-providers/index.ts");

const warningContract =
  /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*WARNING(?:\|[A-Z-]+)* marker;/;

test("a standalone WARNING survives a read summary with its line number", async () => {
  const source = ["export function purge() {", "  // WARNING", "  deleteAll();", "}"].join("\n");
  let receivedPrompt = "";
  let receivedSource = "";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: Array<{ content: string }> };
      receivedPrompt = body.messages[0].content;
      receivedSource = body.messages[1].content;
      const kept = warningContract.test(receivedPrompt)
        ? receivedSource.split("\n").flatMap((line, i) =>
            /^\s*\/\/ WARNING\s*$/.test(line) ? [`${i + 1}: ${line}`] : [],
          )
        : [];
      return Response.json({ choices: [{ message: { content: ["Purges data.", ...kept].join("\n") } }] });
    },
  });
  try {
    const result = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: `http://127.0.0.1:${server.port}/v1`,
    });
    expect(receivedPrompt).toMatch(warningContract);
    expect(receivedSource).toBe(source);
    expect(result.summarized).toBe(true);
    expect(result.fellBack).toBe(false);
    expect(result.text).toStartWith("Purges data.\n2:   // WARNING\n[ashlr summary ·");
  } finally {
    server.stop();
  }
});
