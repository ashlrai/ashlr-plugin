import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { PROMPTS, summarizeIfLarge } from "../servers/_summarize";

const originalHome = process.env.HOME;
let testHome: string;

beforeAll(async () => {
  testHome = await mkdtemp(join(tmpdir(), "ashlr-markers-"));
  process.env.HOME = testHome;
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(testHome, { recursive: true, force: true });
});

describe("read summaries and markers", () => {
  test.each([
    {
      name: "TODO",
      source: "export function load() {\n  // TODO: validate input\n  return 1;\n}\n",
      summary: "Loads a value.\n2: // TODO: validate input",
    },
    {
      name: "FIXME",
      source: "export function save() {\n  // FIXME: handle a failed write\n  return false;\n}\n",
      summary: "Saves a value.\n2: // FIXME: handle a failed write",
    },
    {
      name: "WARNING",
      source: "export function reset() {\n  // WARNING: deletes stored data\n}\n",
      summary: "Resets data.\n2: // WARNING: deletes stored data",
    },
    {
      name: "DEPRECATED",
      source: "export function loadV1() {\n  // DEPRECATED: use loadV2\n}\n",
      summary: "Loads data.\n2: // DEPRECATED: use loadV2",
    },
    {
      name: "SAFETY",
      source: "export function update() {\n  // SAFETY: caller holds the lock\n}\n",
      summary: "Updates data.\n2: // SAFETY: caller holds the lock",
    },
    {
      name: "ordinary prose",
      source: "This module reads a file and returns its contents.\nIt handles an empty file.\n",
      summary: "Reads file contents, including empty files.",
    },
  ])("sends $name to the model with marker instructions and returns its summary", async ({ source, summary }) => {
    let messages: Array<{ role: string; content: string }> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        return Response.json({ choices: [{ message: { content: summary } }] });
      },
    });

    try {
      const result = await summarizeIfLarge(source, {
        toolName: "ashlr__read",
        systemPrompt: PROMPTS.read,
        thresholdBytes: 1,
        endpointOverride: `http://127.0.0.1:${server.port}/v1`,
      });

      expect(messages).toEqual([
        { role: "system", content: PROMPTS.read },
        { role: "user", content: source },
      ]);
      expect(messages![0]!.content).toContain("Preserve VERBATIM with line numbers");
      expect(messages![0]!.content).toContain("TODO|FIXME|XXX|HACK|WARNING|THREAD-UNSAFE|DEPRECATED|NOTE|SAFETY marker");
      expect(messages![0]!.content).toContain("Do not invent markers that are absent from the source.");
      expect(result.summarized).toBe(true);
      expect(result.wasCached).toBe(false);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(summary + "\n[ashlr summary ·");
      expect(result.text).toContain("bypassSummary:true");
    } finally {
      server.stop();
    }
  });

  test("below the threshold, marker comments and prose are returned unchanged", async () => {
    const source = "// TODO: revisit this\nOrdinary prose.\n// FIXME: repair this\n";
    const result = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: Buffer.byteLength(source),
      providerOverride: "off",
    });

    expect(result).toEqual({
      text: source,
      summarized: false,
      wasCached: false,
      fellBack: false,
      outputBytes: Buffer.byteLength(source),
    });
  });

  test("fallback preserves markers at the edges but can elide one in the middle", async () => {
    const source = "// TODO: at the start\n" + "a".repeat(1500) +
      "\n// FIXME: in the middle\n" + "b".repeat(1500) + "\n// TODO: at the end";
    const result = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      providerOverride: "off",
    });

    expect(result.summarized).toBe(false);
    expect(result.wasCached).toBe(false);
    expect(result.fellBack).toBe(true);
    expect(result.text).toContain("// TODO: at the start");
    expect(result.text).toContain("// TODO: at the end");
    expect(result.text).not.toContain("// FIXME: in the middle");
    expect(result.text).toContain("bytes elided");
    expect(result.text).toContain("no LLM provider");
  });
});
