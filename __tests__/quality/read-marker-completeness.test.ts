/**
 * Completeness contract for the marker vocabulary of PROMPTS.read.
 *
 * read-fidelity.test.ts guards each marker's preservation clause
 * individually; read-marker-coverage.test.ts guards that each canonical
 * marker sits inside the "every A|B|… marker;" alternation. This file
 * guards the marker set as a whole — every marker the prompt names, at
 * every stage of the pipeline, remains present:
 *
 *   1. Prompt level — the alternation names EXACTLY the canonical marker
 *      set (nothing missing, nothing extra, nothing duplicated), and every
 *      marker-shaped token appearing anywhere in PROMPTS.read is carried
 *      by the preservation clause. A marker demoted to a plain mention, or
 *      a new marker added outside the clause, fails this test.
 *   2. Wire level — through summarizeIfLarge, the system prompt delivered
 *      to the provider is verbatim PROMPTS.read (still naming every
 *      marker) and the user payload is the complete source text.
 *   3. Output level — markers a provider returns remain present in the
 *      tool-facing summary, and markers inside snipCompact's retained
 *      head/tail regions remain present even when no provider runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { PROMPTS } from "../../servers/_summarize";

// tuner-read-callsite.test.ts installs mock.module("../servers/_summarize")
// at load time, and bun propagates that patch along the re-export chain to
// the defining module — so ANY in-process import of summarizeIfLarge (via
// _summarize or _llm-providers alike) can resolve to that recorder
// depending on file order. A query-suffixed specifier registers a distinct
// module instance the mock never reaches; the code under test is identical.
const IMPL_SPEC: string = "../../servers/_llm-providers/index.ts?unmocked";
const { summarizeIfLarge } = (await import(IMPL_SPEC)) as typeof import(
  "../../servers/_llm-providers/index.ts"
);

// The canonical marker vocabulary the read prompt must preserve verbatim.
const CANONICAL = [
  "TODO",
  "FIXME",
  "XXX",
  "HACK",
  "WARNING",
  "THREAD-UNSAFE",
  "DEPRECATED",
  "NOTE",
  "SAFETY",
] as const;

const MARKER_RE = new RegExp(`\\b(?:${CANONICAL.join("|")})\\b`);

// The verbatim, line-numbered preservation clause and its marker alternation.
const CLAUSE =
  /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)*every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/;

function alternationMarkers(prompt: string): string[] {
  const m = prompt.match(CLAUSE);
  return m ? m[1].split("|") : [];
}

// All-caps words that are prompt directives, not markers. A new ALL-CAPS
// word outside this allowlist is flagged so a human can decide whether it
// is a marker that belongs in the preservation clause.
const DIRECTIVES = new Set(["VERBATIM"]);

/** Every marker-shaped token the prompt names, minus directive words. */
function namedMarkerTokens(prompt: string): Set<string> {
  const named = new Set<string>();
  for (const m of prompt.matchAll(/\b[A-Z][A-Z0-9-]{2,}\b/g)) {
    if (!DIRECTIVES.has(m[0])) named.add(m[0]);
  }
  return named;
}

let tmp: string;
let savedHome: string | undefined;
let stubServer: { stop(): void } | null = null;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ashlr-marker-complete-"));
  savedHome = process.env.HOME;
  process.env.HOME = tmp;
  process.env.ASHLR_STATS_SYNC = "1";
  await mkdir(join(tmp, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  stubServer?.stop();
  stubServer = null;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(tmp, { recursive: true, force: true });
});

/** Stub OpenAI-compatible endpoint that echoes the marker lines it saw. */
function startEchoStub(): { url: string; lastBody: () => any } {
  let lastBody: any = null;
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      lastBody = await req.json();
      const user: string = lastBody.messages?.[1]?.content ?? "";
      const kept = user.split("\n").filter((l) => MARKER_RE.test(l));
      return Response.json({
        choices: [{ message: { content: kept.join("\n") || "no markers found" } }],
      });
    },
  });
  stubServer = { stop: () => srv.stop() };
  return { url: `http://127.0.0.1:${srv.port}/v1`, lastBody: () => lastBody };
}

/** One comment line per canonical marker, built from the table itself. */
const MARKER_LINES: Record<(typeof CANONICAL)[number], string> = {
  TODO: "// TODO: split the parser from the tokenizer",
  FIXME: "// FIXME: CRLF inputs double-count newlines",
  XXX: "// XXX: recursion depth is unbounded on malformed input",
  HACK: "// HACK: sleeps to dodge the fs-watch race",
  WARNING: "// WARNING: mutates the shared module registry",
  "THREAD-UNSAFE": "// THREAD-UNSAFE: caches partial parse trees globally",
  DEPRECATED: "// DEPRECATED: superseded by parseV2; kept for the CLI shim",
  NOTE: "// NOTE: marker order mirrors the prompt's contract",
  SAFETY: "// SAFETY: never eval expressions from untrusted files",
};

function markerSource(markers: readonly string[] = CANONICAL): string {
  const lines = markers.map((m) => MARKER_LINES[m as keyof typeof MARKER_LINES]);
  return [
    "// file: parser.ts — dense with review markers",
    ...lines,
    "/** @deprecated use parseV2 */",
    "export function parse(src: string): number { return src.length; }",
    "module.exports = { parse };",
  ].join("\n");
}

describe("PROMPTS.read — marker set completeness", () => {
  const prompt = PROMPTS.read;

  test("alternation names exactly the canonical marker set", () => {
    const got = alternationMarkers(prompt);
    expect(got.length).toBeGreaterThan(0);
    expect([...got].sort()).toEqual([...CANONICAL].sort());
    // No marker is named twice inside the clause — a duplicate would mask a
    // missing marker while keeping the count unchanged.
    expect(new Set(got).size).toBe(got.length);
  });

  test("every marker-shaped token the prompt names is inside the preservation clause", () => {
    const named = namedMarkerTokens(prompt);
    const covered = new Set(alternationMarkers(prompt));
    const orphan = [...named].filter((t) => !covered.has(t));
    // A marker mentioned outside the clause (e.g. "also note NOSHIP") is a
    // completeness bug: the prompt names it but never asks for verbatim
    // preservation, so the summary can silently drop it.
    expect(orphan).toEqual([]);
    // And the clause may not claim markers the prompt never names.
    expect([...covered].filter((t) => !named.has(t))).toEqual([]);
  });

  test("non-vacuity: demoting or adding markers outside the clause is detected", () => {
    // Demote 7 of 9 markers to a plain mention.
    const demoted = prompt.replace(
      "every TODO|FIXME|XXX|HACK|WARNING|THREAD-UNSAFE|DEPRECATED|NOTE|SAFETY marker;",
      "every TODO|FIXME marker; also note XXX, HACK, WARNING, THREAD-UNSAFE, DEPRECATED, NOTE and SAFETY;",
    );
    expect(demoted).not.toBe(prompt);
    const demotedCovered = new Set(alternationMarkers(demoted));
    const demotedOrphans = [...namedMarkerTokens(demoted)].filter((t) => !demotedCovered.has(t));
    expect(demotedOrphans.sort()).toEqual(
      ["XXX", "HACK", "WARNING", "THREAD-UNSAFE", "DEPRECATED", "NOTE", "SAFETY"].sort(),
    );

    // A brand-new marker named only in prose must be flagged.
    const extended = `${prompt} Also flag every NOSHIP comment.`;
    const extendedOrphans = [...namedMarkerTokens(extended)].filter(
      (t) => !new Set(alternationMarkers(extended)).has(t),
    );
    expect(extendedOrphans).toEqual(["NOSHIP"]);

    // An alternation member that isn't a real marker name breaks the
    // canonical set even though it still parses.
    const bogus = prompt.replace("|SAFETY marker;", "|SAFETY|BOGUS marker;");
    expect(bogus).not.toBe(prompt);
    expect([...alternationMarkers(bogus)].sort()).not.toEqual([...CANONICAL].sort());
  });

  test("named decorator and export examples remain present", () => {
    // The prompt names these concrete examples; dropping one changes what
    // the LLM looks for.
    for (const named of [
      "@deprecated",
      "@Injectable",
      "@staticmethod",
      "export",
      "module.exports",
      "__all__",
    ]) {
      expect(prompt).toContain(named);
    }
  });

  test("anti-invention guard remains present", () => {
    // Completeness cuts both ways: the prompt must also forbid inventing
    // markers that are absent from the source.
    expect(prompt).toContain("Do not invent markers that are absent from the source.");
  });
});

describe("marker completeness through summarizeIfLarge", () => {
  test("LLM path: every named marker reaches the wire and the output", async () => {
    const stub = startEchoStub();
    const source = markerSource();
    const r = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: stub.url,
    });

    expect(r.summarized).toBe(true);
    expect(r.fellBack).toBe(false);

    // Wire level: the system prompt delivered to the provider is verbatim
    // PROMPTS.read — every named marker survives the trip.
    const body = stub.lastBody();
    expect(body.messages[0].content).toBe(PROMPTS.read);
    expect(alternationMarkers(body.messages[0].content).sort()).toEqual([...CANONICAL].sort());

    // The user payload is the complete source — no marker is elided before
    // the provider sees it.
    expect(body.messages[1].content).toBe(source);
    for (const marker of CANONICAL) {
      expect(body.messages[1].content).toContain(marker);
    }

    // Output level: every marker the provider preserved remains present in
    // the tool-facing text.
    for (const marker of CANONICAL) {
      expect(r.text).toContain(marker);
    }
    expect(r.text).toContain("ashlr summary");
    expect(r.text).toContain("bypassSummary:true");
  });

  test("fallback path: markers in retained head/tail regions remain present", async () => {
    // snipCompact keeps the first and last 800 bytes; markers there must
    // survive even when no LLM provider answers. Markers in the elided
    // middle are outside the retained window by design — the verbatim
    // contract lives in the prompt, which is why the LLM path matters.
    const head = ["// file: parser.ts", ...CANONICAL.slice(0, 5).map((m) => MARKER_LINES[m])].join(
      "\n",
    );
    const tail = CANONICAL.slice(5).map((m) => MARKER_LINES[m]).join("\n");
    const filler = `// ${"pad ".repeat(800)}\n`;
    const source = `${head}\n${filler}${tail}`;
    expect(source.length).toBeGreaterThan(2000);
    expect(tail.length).toBeLessThan(800);
    expect(head.length).toBeLessThan(800);

    const r = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: "http://127.0.0.1:1/v1", // intentionally unreachable
      timeoutMs: 500,
    });

    expect(r.fellBack).toBe(true);
    for (const marker of CANONICAL) {
      expect(r.text).toContain(marker);
    }
    // Non-vacuity: bytes really were elided, so the marker assertions above
    // prove retention rather than a pass-through of the whole file.
    expect(r.text).toMatch(/\[\.\.\. \d+ bytes elided \.\.\.\]/);
    expect(r.text).toContain("no LLM provider");
  });

  test("cached path: a second call keeps every named marker", async () => {
    const stub = startEchoStub();
    const source = markerSource();
    await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: stub.url,
    });

    // Second call serves from the on-disk cache with the provider down —
    // the cached summary must still carry every named marker.
    stubServer?.stop();
    stubServer = null;
    const r = await summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      thresholdBytes: 1,
      endpointOverride: "http://127.0.0.1:1/v1",
    });
    expect(r.wasCached).toBe(true);
    expect(r.fellBack).toBe(false);
    for (const marker of CANONICAL) {
      expect(r.text).toContain(marker);
    }
  });
});
