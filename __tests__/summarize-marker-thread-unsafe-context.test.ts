import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPTS } from "../servers/_summarize";

// Avoid mock.module patches installed by other test files on the public facade.
const IMPL_SPEC: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(IMPL_SPEC)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

const contract = /Preserve VERBATIM with line numbers:[^;]*;\s*every (?:[A-Z-]+\|)*THREAD-UNSAFE(?:\|[A-Z-]+)* marker;/;

test("read summary retains a THREAD-UNSAFE marker and its source context", async () => {
  const source = [
    "export function parse(input: string) {",
    "  // THREAD-UNSAFE: shared cache is mutated without a lock",
    "  return sharedCache.get(input);",
    "}",
  ].join("\n");
  let received: Array<{ role: string; content: string }> = [];
  const originalHome = process.env.HOME;
  const originalSync = process.env.ASHLR_STATS_SYNC;
  const testHome = mkdtempSync(join(tmpdir(), "summarize-thread-unsafe-"));
  process.env.HOME = testHome;
  process.env.ASHLR_STATS_SYNC = "1";
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as { messages: typeof received };
      received = body.messages;
      // Simulate a provider following the marker contract, including the
      // annotated statement; this checks the integration, not model quality.
      const lines = received[1].content.split("\n");
      const index = lines.findIndex((line) => line.includes("THREAD-UNSAFE"));
      const summary = contract.test(received[0].content) && index >= 0
        ? `${index + 1}: ${lines[index]}\n${index + 2}: ${lines[index + 1]}`
        : "Parses input.";
      return Response.json({ choices: [{ message: { content: summary } }] });
  }, { preconnect: globalThis.fetch.preconnect }));

  try {
    const result = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: "http://127.0.0.1:12345/v1",
    });
    expect(received).toEqual([
      { role: "system", content: PROMPTS.read },
      { role: "user", content: source },
    ]);
    expect(PROMPTS.read).toMatch(contract);
    expect(result.summarized).toBe(true);
    expect(result.fellBack).toBe(false);
    expect(result.text).toContain(
      "2:   // THREAD-UNSAFE: shared cache is mutated without a lock\n" +
      "3:   return sharedCache.get(input);",
    );
  } finally {
    fetchMock.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSync === undefined) delete process.env.ASHLR_STATS_SYNC;
    else process.env.ASHLR_STATS_SYNC = originalSync;
    rmSync(testHome, { recursive: true, force: true });
  }
});
