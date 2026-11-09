import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROMPTS } from "../servers/_summarize";

// See summarize-marker-note.test.ts: a query-suffixed specifier avoids the
// mock.module patch that tuner-read-callsite.test.ts installs on _summarize.
const IMPL_SPEC: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(IMPL_SPEC)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

const fixmeContract =
  /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*FIXME(?:\|[A-Z-]+)* marker;/;

test("a bare FIXME line keeps the marker and the line it annotates in the summary", async () => {
  const originalHome = process.env.HOME;
  const testHome = mkdtempSync(join(tmpdir(), "summarize-marker-fixme-"));
  const originalSync = process.env.ASHLR_STATS_SYNC;
  process.env.HOME = testHome;
  // Flush stats synchronously so no debounced write outlives this test's HOME.
  process.env.ASHLR_STATS_SYNC = "1";
  const source = [
    "export function retry(fn: () => void) {",
    "  // FIXME",
    "  for (let i = 0; i < 3; i++) fn();",
    "}",
  ].join("\n");
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: Array<{ role: string; content: string }>;
      };
      // Follow the preservation clause only if the delivered prompt carries
      // it: emit each standalone FIXME line plus the line below it.
      const lines = body.messages[1].content.split("\n");
      const kept = fixmeContract.test(body.messages[0].content)
        ? lines.flatMap((line, i) =>
            /\bFIXME\b/.test(line)
              ? [`${i + 1}: ${line}`, `${i + 2}: ${lines[i + 1] ?? ""}`]
              : [],
          )
        : [];
      return Response.json({
        choices: [{ message: { content: ["Retries a callback.", ...kept].join("\n") } }],
      });
    },
  });

  try {
    const result = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: `http://127.0.0.1:${server.port}/v1`,
    });

    expect(PROMPTS.read).toMatch(fixmeContract);
    expect(result.summarized).toBe(true);
    expect(result.fellBack).toBe(false);
    expect(result.text).toStartWith(
      "Retries a callback.\n" +
        "2:   // FIXME\n" +
        "3:   for (let i = 0; i < 3; i++) fn();\n" +
        "[ashlr summary ·",
    );
  } finally {
    server.stop();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSync === undefined) delete process.env.ASHLR_STATS_SYNC;
    else process.env.ASHLR_STATS_SYNC = originalSync;
    rmSync(testHome, { recursive: true, force: true });
  }
});
