import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_THRESHOLD_BYTES, PROMPTS } from "../servers/_summarize";

// tuner-read-callsite.test.ts installs mock.module("../servers/_summarize")
// at load time, and bun propagates that patch along the re-export chain to
// the defining module — so ANY in-process import of summarizeIfLarge (via
// _summarize or _llm-providers alike) can resolve to that recorder
// depending on file order. A query-suffixed specifier registers a distinct
// module instance the mock never reaches; the code under test is identical.
// (Same trick as summarize-marker-note.test.ts.)
const IMPL_SPEC: string = "../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(IMPL_SPEC)) as typeof import(
  "../servers/_llm-providers/index.ts"
);

// The marker under test: a WARNING comment sitting on line 1 of a source
// file. It is the first thing an agent reads, so every summarizeIfLarge
// path must retain it verbatim: the below-threshold pass-through keeps it,
// the LLM prompt tells the model to preserve WARNING lines, the cache
// re-serves the same summary, and the snip fallback keeps the head of the
// source (the facade must never prepend anything in front of it).
const WARNING_LINE = "// WARNING: calling purge wipes every row — no undo";

// The read prompt's preservation clause, scoped to WARNING (same contract
// regex as summarize-marker-warning-comments.test.ts).
const warningContract =
  /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*WARNING(?:\|[A-Z-]+)* marker;/;

const smallSource = [
  WARNING_LINE,
  'import { db } from "./db";',
  "",
  "export function purge() {",
  '  db.query("DELETE FROM rows");',
  "}",
  "",
].join("\n");

function largeSource(): string {
  const filler = Array.from(
    { length: 400 },
    (_, i) => `  const row${i} = { id: ${i}, ts: ${1700000000 + i} };`,
  );
  return [
    WARNING_LINE,
    'import { db } from "./db";',
    "",
    "export function purge() {",
    ...filler,
    '  db.query("DELETE FROM rows");',
    "}",
    "",
  ].join("\n");
}

/** Run `fn` under an isolated $HOME with synchronous stats writes. */
async function withIsolatedHome<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalSync = process.env.ASHLR_STATS_SYNC;
  const home = mkdtempSync(join(tmpdir(), name));
  process.env.HOME = home;
  process.env.ASHLR_STATS_SYNC = "1";
  try {
    return await fn();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSync === undefined) delete process.env.ASHLR_STATS_SYNC;
    else process.env.ASHLR_STATS_SYNC = originalSync;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("first-line WARNING marker through summarizeIfLarge", () => {
  test("below the threshold the warning comes back as the unchanged first line", async () => {
    await withIsolatedHome("warn-first-line-small-", async () => {
      const result = await summarizeIfLarge(smallSource, {
        toolName: "ashlr__read",
        systemPrompt: PROMPTS.read,
      });
      expect(result).toEqual({
        text: smallSource,
        summarized: false,
        wasCached: false,
        fellBack: false,
        outputBytes: Buffer.byteLength(smallSource, "utf-8"),
      });
      expect(result.text.split("\n")[0]).toBe(WARNING_LINE);
    });
  });

  test("an LLM summary retains the first-line warning verbatim", async () => {
    await withIsolatedHome("warn-first-line-llm-", async () => {
      let system = "";
      let user = "";
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as {
            messages: Array<{ role: string; content: string }>;
          };
          system = body.messages[0]!.content;
          user = body.messages[1]!.content;
          // Stand-in model that honours the preservation clause: one purpose
          // line, then every WARNING line verbatim with its line number.
          const kept = warningContract.test(system)
            ? user.split("\n").flatMap((line, i) =>
                /\bWARNING\b/.test(line) ? [`${i + 1}: ${line}`] : [],
              )
            : [];
          return Response.json({
            choices: [{ message: { content: ["Deletes all rows on demand.", ...kept].join("\n") } }],
          });
        },
      });

      try {
        const opts = {
          toolName: "ashlr__read",
          systemPrompt: PROMPTS.read,
          thresholdBytes: 1,
          endpointOverride: `http://127.0.0.1:${server.port}/v1`,
        };
        const result = await summarizeIfLarge(smallSource, opts);

        // The delivered prompt carries the WARNING preservation clause and the
        // model received the source intact (line 1 included).
        expect(system).toMatch(warningContract);
        expect(user).toBe(smallSource);

        expect(result.summarized).toBe(true);
        expect(result.fellBack).toBe(false);
        expect(result.wasCached).toBe(false);
        // The line-1 warning survives verbatim, tagged with its original number.
        expect(result.text).toContain(`1: ${WARNING_LINE}`);
        // The facade prepends nothing and appends only the hint footer.
        expect(result.text).toStartWith(
          `Deletes all rows on demand.\n1: ${WARNING_LINE}\n[ashlr summary ·`,
        );
        expect(result.text).toContain("bypassSummary:true");

        // The cache re-serves the same summary: the warning is still retained.
        const cached = await summarizeIfLarge(smallSource, opts);
        expect(cached.wasCached).toBe(true);
        expect(cached.text).toContain(`1: ${WARNING_LINE}`);
      } finally {
        server.stop();
      }
    });
  });

  test("with no LLM the snip fallback keeps the first-line warning on the first line", async () => {
    await withIsolatedHome("warn-first-line-snip-", async () => {
      const raw = largeSource();
      expect(Buffer.byteLength(raw, "utf-8")).toBeGreaterThan(DEFAULT_THRESHOLD_BYTES);

      const result = await summarizeIfLarge(raw, {
        toolName: "ashlr__read",
        systemPrompt: PROMPTS.read,
        providerOverride: "off",
      });

      expect(result.summarized).toBe(false);
      expect(result.fellBack).toBe(true);
      expect(result.wasCached).toBe(false);
      // Acceptance: the first line of the summary is the source's first line.
      expect(result.text.split("\n")[0]).toBe(WARNING_LINE);
      // Head and tail both survive the elision; the warning sits in the head.
      expect(result.text).toContain("bytes elided");
      expect(result.text).toContain("const row0 = { id: 0, ts: 1700000000 };");
      expect(result.text).toContain('db.query("DELETE FROM rows");');
    });
  });
});
