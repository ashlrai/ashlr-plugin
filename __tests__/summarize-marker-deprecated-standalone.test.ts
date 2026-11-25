import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPTS } from "../servers/_summarize";

// Avoid the cross-file mock.module patch installed by tuner-read-callsite.test.ts.
const impl: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(impl)) as typeof import("../servers/_llm-providers/index.ts");

const deprecatedContract =
  /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*DEPRECATED(?:\|[A-Z-]+)* marker;/;

test("a standalone DEPRECATED marker survives a read summary verbatim with its line number", async () => {
  const originalHome = process.env.HOME;
  const originalSync = process.env.ASHLR_STATS_SYNC;
  const testHome = mkdtempSync(join(tmpdir(), "summarize-deprecated-standalone-"));
  process.env.HOME = testHome;
  // Prevent debounced stats writes from outliving the isolated HOME.
  process.env.ASHLR_STATS_SYNC = "1";
  const source = [
    "export function loadLegacy() {",
    "  // DEPRECATED",
    "  return loadCurrent();",
    "}",
  ].join("\n");
  let messages: Array<{ role: string; content: string }> = [];
  const fetchStub = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: typeof messages };
    messages = body.messages;
    // Model a provider following the delivered preservation clause, using
    // only standalone markers from the source it actually received.
    const kept = deprecatedContract.test(messages[0].content)
      ? messages[1].content.split("\n").flatMap((line, index) =>
          /^\s*\/\/ DEPRECATED\s*$/.test(line) ? [`${index + 1}: ${line}`] : [],
        )
      : [];
    return Response.json({
      choices: [{ message: { content: ["Loads legacy data.", ...kept].join("\n") } }],
    });
  }) as typeof fetch);

  try {
    const result = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: "http://127.0.0.1:1234/v1",
    });

    expect(messages).toEqual([
      { role: "system", content: PROMPTS.read },
      { role: "user", content: source },
    ]);
    expect(messages[0].content).toMatch(deprecatedContract);
    expect(result.summarized).toBe(true);
    expect(result.wasCached).toBe(false);
    expect(result.fellBack).toBe(false);
    expect(result.text).toStartWith(
      "Loads legacy data.\n2:   // DEPRECATED\n[ashlr summary ·",
    );
  } finally {
    fetchStub.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSync === undefined) delete process.env.ASHLR_STATS_SYNC;
    else process.env.ASHLR_STATS_SYNC = originalSync;
    rmSync(testHome, { recursive: true, force: true });
  }
});
