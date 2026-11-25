import { expect, test } from "bun:test";
import { PROMPTS } from "../servers/_summarize";

// Avoid the cross-file mock.module patch described in summarize-marker-note.test.ts.
const impl: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(impl)) as typeof import("../servers/_llm-providers/index.ts");

const warningContract =
  /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*WARNING(?:\|[A-Z-]+)* marker;/;

test("a standalone WARNING survives a read summary with its associated source context", async () => {
  const source = ["export function purge() {", "  // WARNING", "  deleteAll();", "}"].join("\n");
  let receivedPrompt = "";
  let receivedSource = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      receivedPrompt = body.messages[0].content;
      receivedSource = body.messages[1].content;
      // Follow both read-prompt contracts: identify the enclosing function
      // and preserve the standalone marker verbatim at its original line.
      const kept = receivedSource.split("\n").flatMap((line, i) => {
        if (receivedPrompt.includes("key functions/classes (1 line each with line ranges)") &&
            /^export function /.test(line)) {
          return [`${i + 1}-4: ${line}`];
        }
        return warningContract.test(receivedPrompt) && /^\s*\/\/ WARNING\s*$/.test(line)
          ? [`${i + 1}: ${line}`]
          : [];
      });
      return Response.json({ choices: [{ message: { content: ["Purges data.", ...kept].join("\n") } }] });
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
    expect(receivedPrompt).toMatch(warningContract);
    expect(receivedSource).toBe(source);
    expect(result.summarized).toBe(true);
    expect(result.fellBack).toBe(false);
    expect(result.wasCached).toBe(false);
    expect(result.text).toStartWith(
      "Purges data.\n1-4: export function purge() {\n2:   // WARNING\n[ashlr summary ·",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
