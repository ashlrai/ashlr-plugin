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

describe("read prompt marker instructions", () => {
  test.each(["TODO", "FIXME"])("PROMPTS.read names %s as a marker to preserve", (marker) => {
    expect(PROMPTS.read).toMatch(new RegExp(`(^|[^A-Z-])${marker}([^A-Z-]|$)`));
  });

  test("PROMPTS.read instructs preservation of safety markers verbatim with line numbers", () => {
    const clause = PROMPTS.read.match(
      /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)*every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/,
    );
    const markers = clause?.[1].split("|") ?? [];
    expect(markers).toEqual(expect.arrayContaining(["TODO", "FIXME", "SAFETY", "THREAD-UNSAFE"]));
  });
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
      name: "distinct markers on separate lines",
      source: "export function save() {\n  // TODO: validate input\n  const valid = true;\n  // FIXME: handle a failed write\n  return valid;\n}\n",
      summary: "Saves a value.\n2:   // TODO: validate input\n4:   // FIXME: handle a failed write",
    },
    {
      name: "adjacent FIXME and WARNING comments",
      source: "export function save() {\n  // FIXME: retry failed writes\n  // WARNING: retries may duplicate records\n  return write();\n}\n",
      summary: "Saves a value.\n2:   // FIXME: retry failed writes\n3:   // WARNING: retries may duplicate records",
    },
    {
      name: "HACK",
      source: "export function loadLegacy() {\n  // HACK: work around the legacy format\n  return 1;\n}\n",
      summary: "Loads legacy data.\n2: // HACK: work around the legacy format",
    },
    {
      name: "XXX",
      source: "export function reconnect() {\n  // XXX: find the real fix for dropped sockets\n  return retry();\n}\n",
      summary: "Reconnects sockets.\n2: // XXX: find the real fix for dropped sockets",
    },
    {
      name: "NOTE",
      source: "export function migrate() {\n  // NOTE: schema v3 assumes UTC timestamps\n  return migrateRows();\n}\n",
      summary: "Migrates rows.\n2: // NOTE: schema v3 assumes UTC timestamps",
    },
    {
      name: "WARNING",
      source: "export function reset() {\n  // WARNING: deletes stored data\n}\n",
      summary: "Resets data.\n2: // WARNING: deletes stored data",
      retainedLine: "// WARNING: deletes stored data",
    },
    {
      name: "THREAD-UNSAFE",
      source: "export function updateCache() {\n  // THREAD-UNSAFE: caller must hold the cache lock\n}\n",
      summary: "Updates the cache.\n2: // THREAD-UNSAFE: caller must hold the cache lock",
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
      name: "SAFETY comment with continuation text",
      source: "export function readRaw(ptr: number) {\n  // SAFETY: ptr is non-null and aligned;\n  // the buffer outlives this call\n  return unsafeRead(ptr);\n}\n",
      summary: "Reads raw memory.\n2:   // SAFETY: ptr is non-null and aligned;\n3:   // the buffer outlives this call",
      retainedLine: "// SAFETY: ptr is non-null and aligned;",
    },
    {
      name: "ordinary prose",
      source: "This module reads a file and returns its contents.\nIt handles an empty file.\n",
      summary: "Reads file contents, including empty files.",
    },
  ])("sends $name to the model with marker instructions and returns its summary", async ({ source, summary, retainedLine }) => {
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
      if (retainedLine) {
        expect(source).toContain(retainedLine);
        expect(result.text).toContain(retainedLine);
      }
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

describe("read prompt marker instructions", () => {
  test.each(["XXX", "HACK", "WARNING", "DEPRECATED", "NOTE"])(
    "names %s as a marker to preserve verbatim",
    (marker) => {
      const markerList = PROMPTS.read.match(/every ([A-Z|-]+) marker/)?.[1]?.split("|");
      expect(markerList).toContain(marker);
      expect(PROMPTS.read.indexOf("Preserve VERBATIM")).toBeLessThan(PROMPTS.read.indexOf(marker));
    },
  );

  test("names the full marker set verbatim", () => {
    const markerList = PROMPTS.read.match(/every ([A-Z|-]+) marker/)?.[1]?.split("|");
    expect(markerList).toEqual([
      "TODO",
      "FIXME",
      "XXX",
      "HACK",
      "WARNING",
      "THREAD-UNSAFE",
      "DEPRECATED",
      "NOTE",
      "SAFETY",
    ]);
  });
});
