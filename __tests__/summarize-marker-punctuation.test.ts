import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPTS } from "../servers/_summarize";

// Avoid a mock.module replacement of the public facade in other test files.
const implementation: string = "../servers/_llm-providers/index.ts?marker-punctuation";
const { summarizeIfLarge } = (await import(implementation)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

// docs/summary-markers.md: the prompt sets no case, word-boundary or
// comment-syntax rules. A marker followed by punctuation is therefore sent to
// the model unchanged, with the lines around it, and the model decides.
const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;
let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "summarize-punct-"));
  process.env.HOME = testHome;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
});

test.each([
  ["comma", "// TODO, validate the input"],
  ["semicolon", "// FIXME; handle a failed write"],
  ["period", "// NOTE. Timestamps are UTC"],
  ["exclamation", "// WARNING! Deletes stored data"],
  ["parenthesis", "// HACK(legacy): keep the old format"],
  ["hyphen", "// XXX - revisit after the migration"],
  ["closing bracket", "// [SAFETY] the buffer outlives this call"],
])("marker followed by %s reaches the model verbatim with its neighbours", async (_name, markerLine) => {
  const source = [
    "export function run() {",
    "  const before = 1;",
    `  ${markerLine}`,
    "  return before;",
    "}",
  ].join("\n");
  let messages: Array<{ role: string; content: string }> = [];
  globalThis.fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      ({ messages } = JSON.parse(String(init?.body)) as { messages: typeof messages });
      // Simulate a provider that follows the preservation clause: keep the marker line with its number.
      const kept = messages[1]!.content.split("\n").flatMap((line, i) =>
        line.includes(markerLine) ? [`${i + 1}: ${line}`] : [],
      );
      return Response.json({ choices: [{ message: { content: ["Runs.", ...kept].join("\n") } }] });
    },
    { preconnect: originalFetch.preconnect },
  );

  const result = await summarizeIfLarge(source, {
    toolName: "ashlr__read",
    systemPrompt: PROMPTS.read,
    thresholdBytes: 1,
    endpointOverride: "http://127.0.0.1:1234/v1",
  });

  // Surrounding content is untouched: the source is sent byte for byte.
  expect(messages[1]!.content).toBe(source);
  expect(messages[1]!.content.split("\n")[1]).toBe("  const before = 1;");
  expect(messages[1]!.content.split("\n")[3]).toBe("  return before;");
  // The prompt carries no word-boundary or punctuation rule of its own.
  expect(messages[0]!.content).toBe(PROMPTS.read);
  expect(PROMPTS.read).not.toMatch(/word.boundary|punctuation|followed by/i);
  expect(result.summarized).toBe(true);
  expect(result.fellBack).toBe(false);
  expect(result.text).toStartWith(`Runs.\n3:   ${markerLine}\n[ashlr summary ·`);
});
