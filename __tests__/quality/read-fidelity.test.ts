/**
 * Quality regression tests for ashlr__read marker preservation.
 *
 * The prompt assertions and a local provider stub exercise the fidelity
 * contract and its wiring without requiring a live LLM.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("PROMPTS.read — load-bearing marker contract", () => {
  const prompt = PROMPTS.read;
  const xxxContract =
    /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*XXX(?:\|[A-Z-]+)* marker;/;
  const hackContract =
    /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*HACK(?:\|[A-Z-]+)* marker;/;
  const noteContract =
    /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*NOTE(?:\|[A-Z-]+)* marker;/;
  const deprecatedContract =
    /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*DEPRECATED(?:\|[A-Z-]+)* marker;/;
  const warningContract =
    /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*WARNING(?:\|[A-Z-]+)* marker;/;
  const threadUnsafeContract =
    /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*THREAD-UNSAFE(?:\|[A-Z-]+)* marker;/;
  const safetyContract =
    /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*SAFETY(?:\|[A-Z-]+)* marker;/;

  test("asks for @-prefixed decorators/annotations", () => {
    // Must mention the @ symbol so the LLM knows to preserve decorators
    expect(prompt).toContain("@");
    // Must use the word "decorator" or "annotation"
    expect(prompt.toLowerCase()).toMatch(/decorator|annotation/);
  });

  test("requests verbatim THREAD-UNSAFE markers with line numbers", () => {
    expect(prompt).toContain("THREAD-UNSAFE");
    expect(prompt).toMatch(threadUnsafeContract);

    // A separate mention or a longer marker name must not satisfy the contract.
    const withoutMarker = prompt.replace("|THREAD-UNSAFE|", "|");
    expect(withoutMarker).not.toBe(prompt);
    expect(withoutMarker).not.toMatch(threadUnsafeContract);
    expect(withoutMarker).toMatch(deprecatedContract);
    expect(`${withoutMarker} Mention every THREAD-UNSAFE marker;`).not.toMatch(threadUnsafeContract);
    for (const lookalike of ["THREAD-UNSAFE-CHECK", "NOT-THREAD-UNSAFE"]) {
      const mutatedPrompt = prompt.replace("THREAD-UNSAFE", lookalike);
      expect(mutatedPrompt).not.toBe(prompt);
      expect(mutatedPrompt).not.toMatch(threadUnsafeContract);
    }
    expect(prompt.replace("VERBATIM", "")).not.toMatch(threadUnsafeContract);
    expect(prompt.replace("with line numbers", "")).not.toMatch(threadUnsafeContract);
  });

  test("asks for DEPRECATED marker verbatim", () => {
    expect(prompt).toContain("DEPRECATED");
    // Annotation-form deprecation is requested too: @deprecated must be
    // named in the @-prefixed decorator enumeration, not merely elsewhere.
    const annotationContract = /@-prefixed decorator or annotation \(@deprecated\b/;
    expect(prompt).toMatch(annotationContract);
    const withoutAnnotation = prompt.replace("(@deprecated, ", "(@experimental, ");
    expect(withoutAnnotation).not.toBe(prompt);
    expect(withoutAnnotation).not.toMatch(annotationContract);
  });

  test("requests preservation of DEPRECATED markers with line numbers", () => {
    expect(prompt).toMatch(deprecatedContract);

    // A mention outside the preservation clause must not satisfy the contract.
    const withoutDeprecated = prompt.replace("DEPRECATED|", "");
    expect(withoutDeprecated).not.toBe(prompt);
    expect(withoutDeprecated).not.toMatch(deprecatedContract);
    expect(withoutDeprecated).toMatch(threadUnsafeContract);
    expect(`${withoutDeprecated} Mention every DEPRECATED marker;`).not.toMatch(deprecatedContract);
    expect(prompt.replace("VERBATIM", "")).not.toMatch(deprecatedContract);
    expect(prompt.replace("with line numbers", "")).not.toMatch(deprecatedContract);
    expect(prompt.replace("every TODO|", "some TODO|")).not.toMatch(deprecatedContract);
  });

  test("requires DEPRECATED as a complete marker, not part of another word", () => {
    for (const lookalike of ["DEPRECATEDS", "DEPRECATION", "UNDEPRECATED", "DEPRECATED-CHECK"]) {
      const mutatedPrompt = prompt.replace(/\bDEPRECATED\b/, lookalike);
      expect(mutatedPrompt).not.toBe(prompt);
      expect(mutatedPrompt).not.toMatch(deprecatedContract);
    }
  });

  test("requests preservation of TODO markers with line numbers", () => {
    expect(prompt).toMatch(/Preserve VERBATIM with line numbers:[\s\S]*?\bTODO(?:\|[A-Z-]+)* marker/);
  });

  test("asks for TODO|FIXME markers", () => {
    expect(prompt).toMatch(/TODO/);
    expect(prompt).toMatch(/FIXME/);
  });

  test("requests verbatim FIXME markers with line numbers", () => {
    const fixmeContract =
      /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*FIXME(?:\|[A-Z-]+)* marker;/;
    expect(prompt).toMatch(fixmeContract);

    const withoutFixme = prompt.replace("FIXME|", "");
    expect(withoutFixme).not.toBe(prompt);
    expect(withoutFixme).not.toMatch(fixmeContract);
    expect(`${withoutFixme} Mention every FIXME marker;`).not.toMatch(fixmeContract);
    expect(prompt.replace("FIXME", "FIXMES")).not.toMatch(fixmeContract);
    expect(prompt.replace("with line numbers", "")).not.toMatch(fixmeContract);
  });

  test("asks for XXX marker verbatim", () => {
    expect(prompt).toContain("XXX");
    expect(prompt).toMatch(xxxContract);

    const withoutXxx = prompt.replace("XXX|", "");
    expect(withoutXxx).not.toBe(prompt);
    expect(withoutXxx).not.toMatch(xxxContract);
    expect(withoutXxx).toMatch(hackContract);
    expect(`${withoutXxx} Mention every XXX marker;`).not.toMatch(xxxContract);
    for (const lookalike of ["XXXX", "XXX-CHECK", "NOT-XXX"]) {
      const mutatedPrompt = prompt.replace(/\bXXX\b/, lookalike);
      expect(mutatedPrompt).not.toBe(prompt);
      expect(mutatedPrompt).not.toMatch(xxxContract);
    }
    expect(prompt.replace("VERBATIM", "")).not.toMatch(xxxContract);
    expect(prompt.replace("with line numbers", "")).not.toMatch(xxxContract);
    expect(prompt.replace("every TODO|", "some TODO|")).not.toMatch(xxxContract);
  });

  test("asks for HACK marker verbatim", () => {
    expect(prompt).toContain("HACK");
  });

  test("requests verbatim HACK markers with line numbers", () => {
    expect(prompt).toMatch(hackContract);

    // A mention outside the preservation clause must not satisfy the contract.
    const withoutHack = prompt.replace("HACK|", "");
    expect(withoutHack).not.toBe(prompt);
    expect(withoutHack).not.toMatch(hackContract);
    expect(withoutHack).toMatch(xxxContract);
    expect(`${withoutHack} Mention every HACK marker;`).not.toMatch(hackContract);
    for (const lookalike of ["HACKS", "HACKED", "HACKATHON", "SHACK", "HACK-CHECK"]) {
      const mutatedPrompt = prompt.replace(/\bHACK\b/, lookalike);
      expect(mutatedPrompt).not.toBe(prompt);
      expect(mutatedPrompt).not.toMatch(hackContract);
    }
    expect(prompt.replace("VERBATIM", "")).not.toMatch(hackContract);
    expect(prompt.replace("with line numbers", "")).not.toMatch(hackContract);
    expect(prompt.replace("every TODO|", "some TODO|")).not.toMatch(hackContract);
  });

  test("requests preservation of NOTE markers with line numbers", () => {
    expect(prompt).toContain("NOTE");
    expect(prompt).toMatch(noteContract);

    // A mention outside the preservation clause must not satisfy the contract.
    const withoutNote = prompt.replace("|NOTE|", "|");
    expect(withoutNote).not.toBe(prompt);
    expect(withoutNote).not.toMatch(noteContract);
    expect(withoutNote).toMatch(safetyContract);
    expect(`${withoutNote} Mention every NOTE marker;`).not.toMatch(noteContract);
    expect(prompt.replace("VERBATIM", "")).not.toMatch(noteContract);
    expect(prompt.replace("with line numbers", "")).not.toMatch(noteContract);
    expect(prompt.replace("every TODO|", "some TODO|")).not.toMatch(noteContract);
  });

  test("requires NOTE as a complete marker, not part of another word", () => {
    for (const lookalike of ["NOTED", "NOTES", "NOTEBOOK", "FOOTNOTE", "DENOTE", "NOTE-CHECK"]) {
      const mutatedPrompt = prompt.replace(/\bNOTE\b/, lookalike);
      expect(mutatedPrompt).not.toBe(prompt);
      expect(mutatedPrompt).not.toMatch(noteContract);
    }
  });

  test("passes NOTE fixture and preservation instructions to the provider and returns its summary", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export function load() {",
      "  // NOTE: Keep the original order.",
      "  const items = readItems();",
      "  // NOTE: Empty input is valid.",
      "  return items;",
      "}",
    ].join("\n");
    const summary = "Loads items.\n2: // NOTE: Keep the original order.\n4: // NOTE: Empty input is valid.";
    let messages: Array<{ role: string; content: string }> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        return Response.json({ choices: [{ message: { content: summary } }] });
      },
    });

    try {
      const result = await summarizeIfLarge(source, {
        toolName: "ashlr__read",
        systemPrompt: prompt,
        thresholdBytes: 1,
        endpointOverride: `http://127.0.0.1:${server.port}/v1`,
      });

      expect(messages).toEqual([
        { role: "system", content: prompt },
        { role: "user", content: source },
      ]);
      expect(messages![0].content).toMatch(noteContract);
      expect(result.summarized).toBe(true);
      expect(result.wasCached).toBe(false);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(`${summary}\n[ashlr summary ·`);
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("passes a fixture with every remaining marker kind through the provider round-trip", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    // One comment per marker kind the preservation clause names beyond the
    // TODO|FIXME pair — the fidelity contract must carry each kind from the
    // source, across the wire, and into the returned summary.
    const markerLines = [
      "// XXX: recursion depth is unbounded on malformed input",
      "// HACK: sleeps to dodge the fs-watch race",
      "// WARNING: mutates the shared module registry",
      "// THREAD-UNSAFE: caches partial parse trees globally",
      "// DEPRECATED: superseded by parseV2; kept for the CLI shim",
      "// NOTE: marker order mirrors the prompt's contract",
      "// SAFETY: never eval expressions from untrusted files",
    ];
    const source = [
      "export function parse(src: string) {",
      ...markerLines,
      "  return src.length;",
      "}",
    ].join("\n");
    let messages: Array<{ role: string; content: string }> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        // Echo back only the marker lines, as a faithful provider would.
        const kept = body.messages[1].content
          .split("\n")
          .filter((line) => markerLines.includes(line));
        return Response.json({ choices: [{ message: { content: kept.join("\n") } }] });
      },
    });

    try {
      const result = await summarizeIfLarge(source, {
        toolName: "ashlr__read",
        systemPrompt: prompt,
        thresholdBytes: 1,
        endpointOverride: `http://127.0.0.1:${server.port}/v1`,
      });

      // Wire level: the delivered system prompt carries each remaining
      // marker's contract, and the provider sees the complete source.
      expect(messages).toEqual([
        { role: "system", content: prompt },
        { role: "user", content: source },
      ]);
      for (const contract of [
        xxxContract,
        hackContract,
        warningContract,
        threadUnsafeContract,
        deprecatedContract,
        noteContract,
        safetyContract,
      ]) {
        expect(messages![0].content).toMatch(contract);
      }

      // Output level: every marker line the provider preserved reaches the
      // tool-facing summary verbatim.
      expect(result.summarized).toBe(true);
      expect(result.wasCached).toBe(false);
      expect(result.fellBack).toBe(false);
      for (const line of markerLines) {
        expect(result.text).toContain(line);
      }
      expect(result.text).toContain("[ashlr summary ·");
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("asks for WARNING and SAFETY markers", () => {
    expect(prompt).toContain("WARNING");
    expect(prompt).toContain("SAFETY");
  });

  test("requests verbatim WARNING markers with line numbers", () => {
    expect(prompt).toMatch(warningContract);

    // A separate mention or a longer marker name must not satisfy the contract.
    const withoutWarning = prompt.replace("|WARNING|", "|");
    expect(withoutWarning).not.toBe(prompt);
    expect(withoutWarning).not.toMatch(warningContract);
    expect(withoutWarning).toMatch(safetyContract);
    expect(`${withoutWarning} Mention every WARNING marker;`).not.toMatch(warningContract);
    for (const lookalike of ["WARNINGS", "WARNING-CHECK", "PREWARNING"]) {
      const mutatedPrompt = prompt.replace(/\bWARNING\b/, lookalike);
      expect(mutatedPrompt).not.toBe(prompt);
      expect(mutatedPrompt).not.toMatch(warningContract);
    }
    expect(prompt.replace("VERBATIM", "")).not.toMatch(warningContract);
    expect(prompt.replace("with line numbers", "")).not.toMatch(warningContract);
    expect(prompt.replace("every TODO|", "some TODO|")).not.toMatch(warningContract);
  });

  test("requests verbatim SAFETY markers with line numbers", () => {
    expect(prompt).toMatch(safetyContract);

    // A separate mention or a longer marker name must not satisfy the contract.
    const withoutSafety = prompt.replace("|SAFETY", "");
    expect(withoutSafety).not.toBe(prompt);
    expect(withoutSafety).not.toMatch(safetyContract);
    expect(withoutSafety).toMatch(warningContract);
    expect(`${withoutSafety} Mention every SAFETY marker;`).not.toMatch(safetyContract);
    for (const lookalike of ["SAFETYS", "SAFETY-CHECK", "UNSAFETY"]) {
      const mutatedPrompt = prompt.replace(/\bSAFETY\b/, lookalike);
      expect(mutatedPrompt).not.toBe(prompt);
      expect(mutatedPrompt).not.toMatch(safetyContract);
    }
    expect(prompt.replace("VERBATIM", "")).not.toMatch(safetyContract);
    expect(prompt.replace("with line numbers", "")).not.toMatch(safetyContract);
    expect(prompt.replace("every TODO|", "some TODO|")).not.toMatch(safetyContract);
  });

  test("requires THREAD-UNSAFE and SAFETY independently in the preservation clause", () => {
    const contracts = [
      { marker: "THREAD-UNSAFE", contract: threadUnsafeContract },
      { marker: "SAFETY", contract: safetyContract },
    ];

    for (const { marker, contract } of contracts) {
      expect(prompt).toMatch(contract);
      const withoutMarker = prompt.replace(`|${marker}`, "");
      expect(withoutMarker).not.toBe(prompt);
      expect(`${withoutMarker} Mention every ${marker} marker;`).not.toMatch(contract);
      for (const other of contracts.filter((item) => item.marker !== marker)) {
        expect(withoutMarker).toMatch(other.contract);
      }
      expect(prompt.replace("every TODO|", "some TODO|")).not.toMatch(contract);
    }
  });

  test("preserves each distinct marker kind when several appear in one input", () => {
    // A single source file often carries several marker kinds at once — a
    // TODO above a FIXME above a DEPRECATED note. The prompt must keep every
    // kind inside the shared verbatim alternation so each marker stays
    // represented in the requested summary; a kind that falls out of the
    // alternation would be silently dropped from such an input.
    const clause =
      /Preserve VERBATIM with line numbers:[\s\S]*?every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/;
    const match = prompt.match(clause);
    expect(match).not.toBeNull();
    const covered = match![1].split("|");
    for (const marker of [
      "TODO",
      "FIXME",
      "XXX",
      "HACK",
      "WARNING",
      "THREAD-UNSAFE",
      "DEPRECATED",
      "NOTE",
      "SAFETY",
    ]) {
      expect(covered).toContain(marker);
    }

    // Non-vacuity: demoting kinds to a plain mention outside the shared
    // alternation must shrink the covered set.
    const demoted = prompt.replace(
      "|DEPRECATED|NOTE|SAFETY marker;",
      " marker; also mention DEPRECATED, NOTE, and SAFETY;",
    );
    expect(demoted).not.toBe(prompt);
    const demotedCovered = demoted.match(clause)![1].split("|");
    for (const marker of ["DEPRECATED", "NOTE", "SAFETY"]) {
      expect(demotedCovered).not.toContain(marker);
    }

    // A separate XXX mention cannot replace its place among the other markers.
    const withoutXxx = prompt.replace("|XXX|", "|");
    expect(withoutXxx).not.toBe(prompt);
    const xxxMentionedElsewhere = `${withoutXxx} Mention every XXX marker;`;
    const remainingMarkers = xxxMentionedElsewhere.match(clause)![1].split("|");
    expect(remainingMarkers).not.toContain("XXX");
    expect(remainingMarkers).toEqual(covered.filter((marker) => marker !== "XXX"));

    // A separate DEPRECATED mention cannot replace its place among the other markers.
    const withoutDeprecated = prompt.replace("|DEPRECATED|", "|");
    expect(withoutDeprecated).not.toBe(prompt);
    const deprecatedMentionedElsewhere = `${withoutDeprecated} Mention every DEPRECATED marker;`;
    const remainingAfterDemotion = deprecatedMentionedElsewhere.match(clause)![1].split("|");
    expect(remainingAfterDemotion).not.toContain("DEPRECATED");
    expect(remainingAfterDemotion).toEqual(covered.filter((marker) => marker !== "DEPRECATED"));
  });

  test("asks for export statements", () => {
    expect(prompt).toMatch(/export/);
  });

  test("asks for module.exports or __all__", () => {
    expect(prompt).toMatch(/module\.exports|__all__/);
  });

  test("asks for line numbers on markers", () => {
    // The prompt must require line numbers so buried markers are locatable
    expect(prompt.toLowerCase()).toContain("line number");
  });

  test("stays within 800 chars", () => {
    // Keep the prompt tight so it doesn't inflate LLM context cost
    expect(prompt.length).toBeLessThanOrEqual(800);
  });

  test("instructs plain text output (no markdown formatting)", () => {
    // The prompt must tell the LLM to output plain text.
    expect(prompt.toLowerCase()).toContain("plain text");
  });
});
