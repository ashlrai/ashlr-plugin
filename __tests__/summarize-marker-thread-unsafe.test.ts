import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROMPTS } from "../servers/_summarize";

// See summarize-marker-note.test.ts: a query-suffixed specifier avoids
// mock.module patches from other test files leaking into this import.
const IMPL_SPEC: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(IMPL_SPEC)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

const threadUnsafeContract =
  /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*THREAD-UNSAFE(?:\|[A-Z-]+)* marker;/;

describe("read summary THREAD-UNSAFE marker instruction", () => {
  test("lists THREAD-UNSAFE (hyphen intact) in the verbatim-preservation clause", () => {
    expect(PROMPTS.read).toMatch(threadUnsafeContract);
    const withoutIt = PROMPTS.read.replace("|THREAD-UNSAFE|", "|");
    expect(withoutIt).not.toBe(PROMPTS.read);
    expect(withoutIt).not.toMatch(threadUnsafeContract);
    for (const lookalike of ["THREAD_UNSAFE", "THREADUNSAFE", "THREAD-SAFE", "THREAD"]) {
      const mutated = PROMPTS.read.replace("THREAD-UNSAFE", lookalike);
      expect(mutated).not.toMatch(threadUnsafeContract);
    }
  });

  test("delivers the instruction and the THREAD-UNSAFE line stays identifiable in the summary", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "summarize-marker-tu-"));
    process.env.HOME = testHome;
    const source = [
      "let counter = 0;",
      "// THREAD-UNSAFE: counter is mutated without a lock.",
      "export function bump() { return ++counter; } // THREAD-UNSAFE: callers must serialize access",
    ].join("\n");
    let system: string | undefined;
    let receivedSource: string | undefined;
    const fetchStub = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      system = body.messages[0].content;
      receivedSource = body.messages[1].content;
      const markers = threadUnsafeContract.test(system)
        ? body.messages[1].content.split("\n").flatMap((line, index) =>
            /\bTHREAD-UNSAFE:/.test(line) ? [`${index + 1}: ${line}`] : [],
          )
        : [];
      return Response.json({
        choices: [{ message: { content: ["Global counter.", ...markers].join("\n") } }],
      });
    }) as typeof fetch);

    try {
      const result = await summarizeIfLarge(source, {
        toolName: "ashlr__read",
        systemPrompt: PROMPTS.read,
        thresholdBytes: 1,
        endpointOverride: "http://127.0.0.1:1234/v1",
      });
      expect(system).toMatch(threadUnsafeContract);
      expect(receivedSource).toBe(source);
      expect(result.summarized).toBe(true);
      expect(result.wasCached).toBe(false);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(
        "Global counter.\n" +
          "2: // THREAD-UNSAFE: counter is mutated without a lock.\n" +
          "3: export function bump() { return ++counter; } // THREAD-UNSAFE: callers must serialize access\n" +
          "[ashlr summary ·",
      );
    } finally {
      fetchStub.mockRestore();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
