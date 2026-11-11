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

  test("passes THREAD-UNSAFE instructions and source to the provider", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export function update() {",
      "  // THREAD-UNSAFE: callers must hold the cache lock.",
      "  updateCache();",
      "  // THREAD-UNSAFE: the shared counter is not atomic.",
      "  count++;",
      "}",
    ].join("\n");
    let messages: Array<{ role: string; content: string }> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        const markers = threadUnsafeContract.test(body.messages[0].content)
          ? body.messages[1].content.split("\n").flatMap((line, index) =>
              /^\s*\/\/ THREAD-UNSAFE:/.test(line) ? [`${index + 1}: ${line}`] : [],
            )
          : [];
        return Response.json({ choices: [{ message: { content: ["Updates cache.", ...markers].join("\n") } }] });
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
      expect(messages![0].content).toMatch(threadUnsafeContract);
      expect(result.summarized).toBe(true);
      expect(result.wasCached).toBe(false);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(
        "Updates cache.\n2:   // THREAD-UNSAFE: callers must hold the cache lock.\n4:   // THREAD-UNSAFE: the shared counter is not atomic.\n[ashlr summary ·",
      );
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("THREAD-UNSAFE marker is dropped when the prompt omits the contract (negative control)", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-neg-"));
    process.env.HOME = testHome;
    const source = ["function f() {", "  // THREAD-UNSAFE: not reentrant.", "  g();", "}"].join("\n");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        const markers = threadUnsafeContract.test(body.messages[0].content) ? ["kept THREAD-UNSAFE"] : [];
        return Response.json({ choices: [{ message: { content: ["Calls g.", ...markers].join("\n") } }] });
      },
    });

    try {
      const weakened = prompt.replace("|THREAD-UNSAFE|", "|");
      expect(weakened).not.toMatch(threadUnsafeContract);
      const result = await summarizeIfLarge(source, {
        toolName: "ashlr__read",
        systemPrompt: weakened,
        thresholdBytes: 1,
        endpointOverride: `http://127.0.0.1:${server.port}/v1`,
      });
      expect(result.summarized).toBe(true);
      expect(result.text).not.toContain("THREAD-UNSAFE");
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("asks for DEPRECATED marker verbatim", () => {
    expect(prompt).toContain("DEPRECATED");
    // DEPRECATED appears exactly once, inside the preservation clause — an
    // incidental mention elsewhere cannot satisfy this assertion. The
    // lowercase @deprecated annotation is a different token and is checked
    // separately below.
    expect(prompt.match(/\bDEPRECATED\b/g)).toHaveLength(1);
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

  test("DEPRECATED markers survive summarization with line numbers", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export function legacyParse(input: string) {",
      "  // DEPRECATED: use parseV2 instead.",
      "  return JSON.parse(input);",
      "}",
      "/** @deprecated removed in 3.0 */",
      "// DEPRECATED: slated for removal.",
      "export const OLD_FLAG = true;",
    ].join("\n");
    let messages: Array<{ role: string; content: string }> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        // Echo markers only when the prompt carries the DEPRECATED contract,
        // so a regression in the prompt surfaces as a missing marker.
        const markers = deprecatedContract.test(body.messages[0].content)
          ? body.messages[1].content.split("\n").flatMap((line, index) =>
              /DEPRECATED:/.test(line) ? [`${index + 1}: ${line}`] : [],
            )
          : [];
        return Response.json({ choices: [{ message: { content: ["Legacy parsing helpers.", ...markers].join("\n") } }] });
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
      expect(result.summarized).toBe(true);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(
        "Legacy parsing helpers.\n2:   // DEPRECATED: use parseV2 instead.\n6: // DEPRECATED: slated for removal.\n[ashlr summary ·",
      );
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("requires DEPRECATED as a complete marker, not part of another word", () => {
    for (const lookalike of ["DEPRECATEDS", "DEPRECATION", "UNDEPRECATED", "DEPRECATED-CHECK"]) {
      const mutatedPrompt = prompt.replace(/\bDEPRECATED\b/, lookalike);
      expect(mutatedPrompt).not.toBe(prompt);
      expect(mutatedPrompt).not.toMatch(deprecatedContract);
    }
  });

  test("lists DEPRECATED between THREAD-UNSAFE and NOTE in the marker alternation, and only in the read prompt", () => {
    expect(prompt).toContain("THREAD-UNSAFE|DEPRECATED|NOTE");
    for (const [name, other] of Object.entries(PROMPTS)) {
      if (name === "read") continue;
      expect(other).not.toMatch(/\bDEPRECATED\b/);
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

  test("FIXME markers survive summarization through the provider round-trip", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const fixmeContract =
      /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*FIXME(?:\|[A-Z-]+)* marker;/;
    const source = [
      "export function retry(fn: () => Promise<void>) {",
      "  // FIXME: backoff is linear; should be exponential.",
      "  return fn();",
      "  // FIXMEUP is not a marker",
      "  // FIXME: swallow of AbortError hides cancellations.",
      "}",
    ].join("\n");
    // Stub provider: keeps FIXME lines only when the system prompt requests it.
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        const markers = fixmeContract.test(body.messages[0].content)
          ? body.messages[1].content.split("\n").flatMap((line, index) =>
              /^\s*\/\/ FIXME:/.test(line) ? [`${index + 1}: ${line}`] : [],
            )
          : [];
        return Response.json({ choices: [{ message: { content: ["Retries a call.", ...markers].join("\n") } }] });
      },
    });
    const run = (systemPrompt: string, input: string) =>
      summarizeIfLarge(input, {
        toolName: "ashlr__read",
        systemPrompt,
        thresholdBytes: 1,
        endpointOverride: `http://127.0.0.1:${server.port}/v1`,
      });

    try {
      const withContract = await run(prompt, source);
      expect(withContract.summarized).toBe(true);
      expect(withContract.fellBack).toBe(false);
      expect(withContract.text).toStartWith(
        "Retries a call.\n2:   // FIXME: backoff is linear; should be exponential.\n5:   // FIXME: swallow of AbortError hides cancellations.\n[ashlr summary ·",
      );
      expect(withContract.text).not.toContain("FIXMEUP");

      // Negative control: dropping FIXME from the contract drops the markers.
      // The input differs so the summary cache cannot replay the first result.
      const withoutFixme = prompt.replace("FIXME|", "");
      expect(withoutFixme).not.toBe(prompt);
      const withoutContract = await run(withoutFixme, `${source}\n// end`);
      expect(withoutContract.summarized).toBe(true);
      expect(withoutContract.text).not.toContain("FIXME: backoff");
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
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

  test("keeps XXX preservation scoped to markers present in the source", () => {
    // The XXX request must sit in the same clause as the no-invention guard,
    // and the standalone token must appear exactly once so it cannot be
    // satisfied by an incidental mention elsewhere in the prompt.
    expect(prompt.match(/\bXXX\b/g)).toHaveLength(1);
    expect(prompt).toMatch(/every (?:[A-Z-]+\|)*XXX(?:\|[A-Z-]+)* marker;[\s\S]*?\. Do not invent markers that are absent from the source\./);
    expect(prompt.replace("Do not invent markers that are absent from the source. ", "")).not.toBe(prompt);
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

  test("keeps a HACK source comment visible, with its line number, in the provider round-trip summary", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export function watch(path: string) {",
      "  // HACK: sleeps to dodge the fs-watch race",
      "  const handle = open(path);",
      "  return handle; // HACK: leaks the handle until process exit",
      "}",
    ].join("\n");
    let messages: Array<{ role: string; content: string }> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        // Follow the preservation clause only when the delivered prompt
        // actually carries the HACK contract, using the source it received.
        const hacks = body.messages[0].content.match(hackContract)
          ? body.messages[1].content.split("\n").flatMap((line, index) =>
              /\bHACK:/.test(line) ? [`${index + 1}: ${line}`] : [],
            )
          : [];
        return Response.json({ choices: [{ message: { content: ["Opens a watch handle.", ...hacks].join("\n") } }] });
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
      expect(messages![0].content).toMatch(hackContract);
      expect(result.summarized).toBe(true);
      expect(result.wasCached).toBe(false);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(
        "Opens a watch handle.\n" +
          "2:   // HACK: sleeps to dodge the fs-watch race\n" +
          "4:   return handle; // HACK: leaks the handle until process exit\n" +
          "[ashlr summary ·",
      );
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("keeps HACK preservation scoped to markers present in the source", () => {
    // The standalone token must appear exactly once, inside the preservation
    // clause that carries the no-invention guard.
    expect(prompt.match(/\bHACK\b/g)).toHaveLength(1);
    expect(prompt).toMatch(/every (?:[A-Z-]+\|)*HACK(?:\|[A-Z-]+)* marker;[\s\S]*?\. Do not invent markers that are absent from the source\./);
  });

  test("HACK marker is dropped when the prompt omits the contract (negative control)", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-neg-"));
    process.env.HOME = testHome;
    const source = ["function f() {", "  // HACK: retries until the lock frees.", "  g();", "}"].join("\n");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        const markers = hackContract.test(body.messages[0].content) ? ["kept HACK"] : [];
        return Response.json({ choices: [{ message: { content: ["Calls g.", ...markers].join("\n") } }] });
      },
    });

    try {
      const weakened = prompt.replace("HACK|", "");
      expect(weakened).not.toBe(prompt);
      expect(weakened).not.toMatch(hackContract);
      const result = await summarizeIfLarge(source, {
        toolName: "ashlr__read",
        systemPrompt: weakened,
        thresholdBytes: 1,
        endpointOverride: `http://127.0.0.1:${server.port}/v1`,
      });
      expect(result.summarized).toBe(true);
      expect(result.text).not.toContain("HACK");
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
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

  test("keeps DEPRECATED comment and @deprecated annotation lines, and invents none when absent", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const withMarkers = [
      "/** @deprecated use fetchV2 */",
      "export function fetch() {}",
      "# DEPRECATED: remove in 3.0",
      "export const x = 1;",
    ].join("\n");
    const withoutMarkers = "export function ok() {}\nexport const y = 2;";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        // Provider that honours the DEPRECATED clause only if the prompt requests it.
        const honours = deprecatedContract.test(body.messages[0].content);
        const kept = body.messages[1].content.split("\n").flatMap((line, index) =>
          honours && /DEPRECATED|@deprecated/.test(line) ? [`${index + 1}: ${line}`] : []);
        return Response.json({ choices: [{ message: { content: ["Summary.", ...kept].join("\n") } }] });
      },
    });
    const run = (source: string) => summarizeIfLarge(source, {
      toolName: "ashlr__read",
      systemPrompt: prompt,
      thresholdBytes: 1,
      endpointOverride: `http://127.0.0.1:${server.port}/v1`,
    });

    try {
      const marked = await run(withMarkers);
      expect(marked.summarized).toBe(true);
      expect(marked.text).toContain("1: /** @deprecated use fetchV2 */");
      expect(marked.text).toContain("3: # DEPRECATED: remove in 3.0");

      const clean = await run(withoutMarkers);
      expect(clean.text).not.toMatch(/DEPRECATED|@deprecated/);
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("passes NOTE and DEPRECATED preservation instructions to the provider and returns their numbered lines", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export function load() {",
      "  // NOTE: Keep the original order.",
      "  const items = readItems();",
      "  // NOTE: Empty input is valid.",
      "  // DEPRECATED: Use loadV2 instead.",
      "  return items;",
      "}",
    ].join("\n");
    let messages: Array<{ role: string; content: string }> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        // Model a provider that follows the preservation clause using the
        // actual source it received, rather than returning a canned fixture.
        const contracts = { NOTE: noteContract, DEPRECATED: deprecatedContract };
        const markers = body.messages[1].content.split("\n").flatMap((line, index) => {
          const marker = line.match(/^\s*\/\/ (NOTE|DEPRECATED):/)?.[1] as keyof typeof contracts | undefined;
          return marker && contracts[marker].test(body.messages[0].content) ? [`${index + 1}: ${line}`] : [];
        });
        return Response.json({ choices: [{ message: { content: ["Loads items.", ...markers].join("\n") } }] });
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
      expect(messages![0].content).toMatch(deprecatedContract);
      expect(result.summarized).toBe(true);
      expect(result.wasCached).toBe(false);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(
        "Loads items.\n2:   // NOTE: Keep the original order.\n4:   // NOTE: Empty input is valid.\n5:   // DEPRECATED: Use loadV2 instead.\n[ashlr summary ·",
      );
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("keeps a fixture's DEPRECATED marker line, with its line number, only when the prompt requests it", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export function parseV1(input: string) {",
      "// DEPRECATED: parseV1 is superseded by parseV2.",
      "// DEPRECATEDS is a lookalike and must not be treated as a marker.",
      "  return input;",
      "}",
    ].join("\n");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        const honours = deprecatedContract.test(body.messages[0].content);
        const kept = body.messages[1].content.split("\n").flatMap((line, index) =>
          honours && /\bDEPRECATED:/.test(line) ? [`${index + 1}: ${line}`] : []);
        return Response.json({ choices: [{ message: { content: ["Parses input.", ...kept].join("\n") } }] });
      },
    });
    const run = (systemPrompt: string, input = source) => summarizeIfLarge(input, {
      toolName: "ashlr__read",
      systemPrompt,
      thresholdBytes: 1,
      endpointOverride: `http://127.0.0.1:${server.port}/v1`,
    });

    try {
      const withContract = await run(prompt);
      expect(withContract.summarized).toBe(true);
      expect(withContract.wasCached).toBe(false);
      expect(withContract.fellBack).toBe(false);
      expect(withContract.text).toStartWith(
        "Parses input.\n2: // DEPRECATED: parseV1 is superseded by parseV2.\n[ashlr summary ·",
      );
      expect(withContract.text).not.toContain("DEPRECATEDS");

      // Negative control: without the DEPRECATED clause the marker is not preserved.
      // The input differs so the summary cache cannot replay the first result.
      const weakenedPrompt = prompt.replace("|DEPRECATED|", "|");
      expect(weakenedPrompt).not.toMatch(deprecatedContract);
      const withoutContract = await run(weakenedPrompt, `${source}\n// end`);
      expect(withoutContract.summarized).toBe(true);
      expect(withoutContract.wasCached).toBe(false);
      expect(withoutContract.fellBack).toBe(false);
      expect(withoutContract.text).not.toContain("DEPRECATED: parseV1 is superseded");
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("keeps a fixture's NOTE marker line, with its line number, only when the prompt requests it", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export const limit = 10;",
      "// NOTE: limit mirrors the server-side quota.",
      "// NOTED is a lookalike and must not be treated as a marker.",
    ].join("\n");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        const honours = noteContract.test(body.messages[0].content);
        const kept = body.messages[1].content.split("\n").flatMap((line, index) =>
          honours && /\bNOTE:/.test(line) ? [`${index + 1}: ${line}`] : []);
        return Response.json({ choices: [{ message: { content: ["Exports a limit.", ...kept].join("\n") } }] });
      },
    });
    const run = (systemPrompt: string, input = source) => summarizeIfLarge(input, {
      toolName: "ashlr__read",
      systemPrompt,
      thresholdBytes: 1,
      endpointOverride: `http://127.0.0.1:${server.port}/v1`,
    });

    try {
      const withContract = await run(prompt);
      expect(withContract.summarized).toBe(true);
      expect(withContract.text).toContain("2: // NOTE: limit mirrors the server-side quota.");
      expect(withContract.text).not.toContain("3: // NOTED");

      // Negative control: without the NOTE clause the marker is not preserved.
      // The input differs so the summary cache cannot replay the first result.
      const withoutContract = await run(prompt.replace("|NOTE|", "|"), `${source}\n// end`);
      expect(withoutContract.text).not.toContain("NOTE: limit mirrors");
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
    const contracts = [
      xxxContract,
      hackContract,
      warningContract,
      threadUnsafeContract,
      deprecatedContract,
      noteContract,
      safetyContract,
    ];
    const preserveRequestedMarkers = (systemPrompt: string, input: string) =>
      input.split("\n").flatMap((line, index) => {
        const markerIndex = markerLines.indexOf(line);
        return markerIndex >= 0 && contracts[markerIndex].test(systemPrompt)
          ? [`${index + 1}: ${line}`]
          : [];
      });
    // Prove the provider stub depends on the WARNING preservation request.
    const withoutWarning = prompt.replace("|WARNING|", "|");
    expect(withoutWarning).not.toBe(prompt);
    expect(preserveRequestedMarkers(withoutWarning, source)).toEqual(
      preserveRequestedMarkers(prompt, source).filter((line) => !line.includes("// WARNING:")),
    );
    expect(preserveRequestedMarkers(prompt, source)).toContain("4: // WARNING: mutates the shared module registry");
    let messages: Array<{ role: string; content: string }> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        // Model a provider that preserves only markers requested by the prompt.
        const kept = preserveRequestedMarkers(body.messages[0].content, body.messages[1].content);
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
      for (const contract of contracts) {
        expect(messages![0].content).toMatch(contract);
      }

      // Output level: every marker line the provider preserved reaches the
      // tool-facing summary verbatim.
      expect(result.summarized).toBe(true);
      expect(result.wasCached).toBe(false);
      expect(result.fellBack).toBe(false);
      for (const [index, line] of markerLines.entries()) {
        expect(result.text).toContain(`${index + 2}: ${line}`);
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

  test("passes WARNING instructions and source to the provider and keeps numbered WARNING lines", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export function reset() {",
      "  // WARNING: drops every cached session.",
      "  clearSessions();",
      "  // WARNING: callers must re-authenticate afterwards.",
      "}",
    ].join("\n");
    let messages: Array<{ role: string; content: string }> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        // Preserve WARNING lines only when the delivered prompt asks for them.
        const markers = warningContract.test(body.messages[0].content)
          ? body.messages[1].content.split("\n").flatMap((line, index) =>
              /^\s*\/\/ WARNING:/.test(line) ? [`${index + 1}: ${line}`] : [],
            )
          : [];
        return Response.json({ choices: [{ message: { content: ["Clears sessions.", ...markers].join("\n") } }] });
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
      expect(messages![0].content).toMatch(warningContract);
      expect(result.summarized).toBe(true);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(
        "Clears sessions.\n2:   // WARNING: drops every cached session.\n4:   // WARNING: callers must re-authenticate afterwards.\n[ashlr summary ·",
      );
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("keeps a fixture's WARNING marker line, with its line number, only when the prompt requests it", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export const registry = new Map();",
      "// WARNING: registry is shared across all workers.",
      "// WARNINGS is a lookalike and must not be treated as a marker.",
    ].join("\n");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        const honours = warningContract.test(body.messages[0].content);
        const kept = body.messages[1].content.split("\n").flatMap((line, index) =>
          honours && /\bWARNING:/.test(line) ? [`${index + 1}: ${line}`] : []);
        return Response.json({ choices: [{ message: { content: ["Exports a registry.", ...kept].join("\n") } }] });
      },
    });
    const run = (systemPrompt: string, input = source) => summarizeIfLarge(input, {
      toolName: "ashlr__read",
      systemPrompt,
      thresholdBytes: 1,
      endpointOverride: `http://127.0.0.1:${server.port}/v1`,
    });

    try {
      const withContract = await run(prompt);
      expect(withContract.summarized).toBe(true);
      expect(withContract.text).toContain("2: // WARNING: registry is shared across all workers.");
      expect(withContract.text).not.toContain("3: // WARNINGS");

      // Negative control: without the WARNING clause the marker is not preserved.
      // The input differs so the summary cache cannot replay the first result.
      const withoutContract = await run(prompt.replace("|WARNING|", "|"), `${source}\n// end`);
      expect(withoutContract.text).not.toContain("WARNING: registry is shared");
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("asks for WARNING marker verbatim, and only in the preservation clause", () => {
    expect(prompt).toContain("WARNING");
    // WARNING appears exactly once, inside the marker alternation — the
    // same single-occurrence pin DEPRECATED, XXX, and SAFETY carry, so an
    // incidental mention elsewhere cannot substitute for the request.
    expect(prompt.match(/\bWARNING\b/g)).toHaveLength(1);
    expect(prompt).toMatch(warningContract);
  });

  test("scopes the WARNING request under the do-not-invent guard", () => {
    // The marker clause naming WARNING and the no-invention guard must sit
    // in one block: the guard protects exactly the markers the alternation
    // promises, so splitting them breaks the fidelity contract.
    const guarded =
      /every (?:[A-Z-]+\|)*WARNING(?:\|[A-Z-]+)* marker;[\s\S]*?Do not invent markers that are absent from the source\./;
    expect(prompt).toMatch(guarded);
    // Negative control: the guard is load-bearing — remove it and the
    // scoped request must no longer resolve.
    const unguarded = prompt.replace("Do not invent markers that are absent from the source. ", "");
    expect(unguarded).not.toBe(prompt);
    expect(unguarded).not.toMatch(guarded);
  });

  test("invents no WARNING markers when the source has none, and keeps the markers it does have", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export function retry(fn: () => Promise<void>) {",
      "  // TODO: tighten the backoff policy.",
      "  // warning: this lowercase note is prose, not the WARNING marker",
      "  return withBackoff(fn);",
      "}",
    ].join("\n");
    const todoContract =
      /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*TODO(?:\|[A-Z-]+)* marker;/;
    let messages: Array<{ role: string; content: string }> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        const honours = {
          TODO: todoContract.test(body.messages[0].content),
          WARNING: warningContract.test(body.messages[0].content),
        };
        const kept = body.messages[1].content.split("\n").flatMap((line, index) => {
          const isTodo = honours.TODO && /^\s*\/\/ TODO:/.test(line);
          const isWarning = honours.WARNING && /\bWARNING:/.test(line);
          return isTodo || isWarning ? [`${index + 1}: ${line}`] : [];
        });
        return Response.json({ choices: [{ message: { content: ["Retries with backoff.", ...kept].join("\n") } }] });
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
      expect(result.summarized).toBe(true);
      expect(result.wasCached).toBe(false);
      expect(result.fellBack).toBe(false);
      // The guard is load-bearing: the lowercase "warning" prose must not
      // be promoted into a preserved marker line.
      expect(result.text).not.toMatch(/WARNING/);
      // ...and narrow: a genuinely requested marker in the same source
      // still survives.
      expect(result.text).toContain("2:   // TODO: tighten the backoff policy.");
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("keeps WARNING in every comment form and position, and keeps the shorter WARN token out", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export function sweep(root: string) {",
      "  // WARNING: deletes every file under root without confirmation",
      "  # WARNING: python callers must hold the sweep lock",
      "  /* WARNING: block-comment form must survive too */",
      "  // WARN: the shorthand is not the WARNING marker",
      "  const result = runSweep(root);",
      "  return result; // WARNING: caller must release the sweep lock",
      "}",
    ].join("\n");
    let messages: Array<{ role: string; content: string }> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        // Follow the preservation clause only when the delivered prompt
        // carries it; any comment syntax counts, but the shorter WARN
        // token does not.
        const honours = warningContract.test(body.messages[0].content);
        const kept = body.messages[1].content.split("\n").flatMap((line, index) =>
          honours && /\bWARNING:/.test(line) ? [`${index + 1}: ${line}`] : []);
        return Response.json({ choices: [{ message: { content: ["Sweeps a tree.", ...kept].join("\n") } }] });
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
      expect(result.summarized).toBe(true);
      expect(result.wasCached).toBe(false);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(
        "Sweeps a tree.\n" +
          "2:   // WARNING: deletes every file under root without confirmation\n" +
          "3:   # WARNING: python callers must hold the sweep lock\n" +
          "4:   /* WARNING: block-comment form must survive too */\n" +
          "7:   return result; // WARNING: caller must release the sweep lock\n" +
          "[ashlr summary ·",
      );
      // The shorter WARN token is not the WARNING marker and must not be
      // preserved in its place.
      expect(result.text).not.toContain("WARN: the shorthand");
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("asks for SAFETY marker verbatim", () => {
    expect(prompt).toContain("SAFETY");
    // SAFETY appears exactly once, inside the preservation clause — an
    // incidental mention elsewhere cannot satisfy this assertion.
    expect(prompt.match(/\bSAFETY\b/g)).toHaveLength(1);
    const withoutSafety = prompt.replace("|SAFETY", "");
    expect(withoutSafety).not.toBe(prompt);
    expect(withoutSafety).not.toContain("SAFETY");
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

  test("passes SAFETY instructions and source to the provider and keeps numbered SAFETY lines", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export function render(template: string) {",
      "  // SAFETY: never eval expressions from untrusted files.",
      "  const html = interpolate(template);",
      "  return html; // SAFETY: caller must sanitize before DOM insertion.",
      "}",
    ].join("\n");
    let messages: Array<{ role: string; content: string }> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        // Preserve SAFETY lines only when the delivered prompt asks for them.
        const markers = safetyContract.test(body.messages[0].content)
          ? body.messages[1].content.split("\n").flatMap((line, index) =>
              /\bSAFETY:/.test(line) ? [`${index + 1}: ${line}`] : [],
            )
          : [];
        return Response.json({ choices: [{ message: { content: ["Interpolates a template.", ...markers].join("\n") } }] });
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
      expect(messages![0].content).toMatch(safetyContract);
      expect(result.summarized).toBe(true);
      expect(result.wasCached).toBe(false);
      expect(result.fellBack).toBe(false);
      expect(result.text).toStartWith(
        "Interpolates a template.\n" +
          "2:   // SAFETY: never eval expressions from untrusted files.\n" +
          "4:   return html; // SAFETY: caller must sanitize before DOM insertion.\n" +
          "[ashlr summary ·",
      );
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("keeps a fixture's SAFETY marker line, with its line number, only when the prompt requests it", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-"));
    process.env.HOME = testHome;
    const source = [
      "export function interpolate(template: string) {",
      "// SAFETY: the template is interpolated into HTML.",
      "// SAFETYCHECK is a lookalike and must not be treated as a marker.",
      "  return template;",
      "}",
    ].join("\n");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        const honours = safetyContract.test(body.messages[0].content);
        const kept = body.messages[1].content.split("\n").flatMap((line, index) =>
          honours && /\bSAFETY:/.test(line) ? [`${index + 1}: ${line}`] : []);
        return Response.json({ choices: [{ message: { content: ["Interpolates a template.", ...kept].join("\n") } }] });
      },
    });
    const run = (systemPrompt: string, input = source) => summarizeIfLarge(input, {
      toolName: "ashlr__read",
      systemPrompt,
      thresholdBytes: 1,
      endpointOverride: `http://127.0.0.1:${server.port}/v1`,
    });

    try {
      const withContract = await run(prompt);
      expect(withContract.summarized).toBe(true);
      expect(withContract.text).toContain("2: // SAFETY: the template is interpolated into HTML.");
      expect(withContract.text).not.toContain("SAFETYCHECK");

      // Negative control: without the SAFETY clause the marker is not preserved.
      // The input differs so the summary cache cannot replay the first result.
      const withoutContract = await run(prompt.replace("|SAFETY", ""), `${source}\n// end`);
      expect(withoutContract.text).not.toContain("SAFETY: the template is interpolated");
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
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

    // A separate HACK mention cannot replace its place among the other markers.
    const withoutHack = prompt.replace("|HACK|", "|");
    expect(withoutHack).not.toBe(prompt);
    const hackMentionedElsewhere = `${withoutHack} Mention every HACK marker;`;
    const remainingAfterHack = hackMentionedElsewhere.match(clause)![1].split("|");
    expect(remainingAfterHack).not.toContain("HACK");
    expect(remainingAfterHack).toEqual(covered.filter((marker) => marker !== "HACK"));

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

  test("requests preservation of line numbers as an instruction, not a passing mention", () => {
    // Verbatim items must carry line numbers, and the prompt must pin the
    // instruction to the preserve clause (not just mention "line number").
    expect(prompt).toMatch(/Preserve VERBATIM with line numbers:/);
    // Key symbols are located by line range too.
    expect(prompt).toMatch(/key functions\/classes \(1 line each with line ranges\)/);
    // Negative control: removing the instruction must break the contract.
    expect(prompt.replaceAll("with line numbers", "")).not.toMatch(
      /Preserve VERBATIM with line numbers:/,
    );
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

describe("PROMPTS.read — THREAD-UNSAFE marker is listed once and not invented", () => {
  const prompt = PROMPTS.read;

  test("THREAD-UNSAFE appears exactly once, as a whole marker-list token", () => {
    expect(prompt.match(/THREAD-UNSAFE/g)).toHaveLength(1);
    expect(prompt).toMatch(/(?:^|[|\s])THREAD-UNSAFE(?=[|\s])/);
  });

  test("forbids inventing markers absent from the source", () => {
    expect(prompt).toContain("Do not invent markers that are absent from the source.");
  });

  test("keeps THREAD-UNSAFE inside the VERBATIM clause, ahead of the output-format sentence", () => {
    const verbatim = prompt.indexOf("Preserve VERBATIM with line numbers:");
    const marker = prompt.indexOf("THREAD-UNSAFE");
    const format = prompt.indexOf("Output as plain text");
    expect(verbatim).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(verbatim);
    expect(marker).toBeLessThan(format);
  });
});

describe("PROMPTS.read — WARNING and DEPRECATED markers together", () => {
  const prompt = PROMPTS.read;
  const contractFor = (marker: string) =>
    new RegExp(
      `Preserve VERBATIM with line numbers:\\s*(?:[^;]*;\\s*)?every (?:[A-Z-]+\\|)*${marker}(?:\\|[A-Z-]+)* marker;`,
    );
  const warningContract = contractFor("WARNING");
  const deprecatedContract = contractFor("DEPRECATED");

  test("lists each marker exactly once as a whole token inside the VERBATIM clause", () => {
    const verbatim = prompt.indexOf("Preserve VERBATIM with line numbers:");
    const format = prompt.indexOf("Output as plain text");
    for (const marker of ["WARNING", "DEPRECATED"]) {
      // @deprecated (lowercase annotation) is a different token and must not count.
      expect(prompt.match(new RegExp(`\\b${marker}\\b`, "g"))).toHaveLength(1);
      expect(prompt).toMatch(new RegExp(`(?:^|[|\\s])${marker}(?=[|\\s])`));
      expect(prompt.indexOf(marker)).toBeGreaterThan(verbatim);
      expect(prompt.indexOf(marker)).toBeLessThan(format);
    }
    expect(prompt).toMatch(warningContract);
    expect(prompt).toMatch(deprecatedContract);
  });

  test("dropping one marker leaves the other contract intact", () => {
    const withoutWarning = prompt.replace("|WARNING|", "|");
    const withoutDeprecated = prompt.replace("|DEPRECATED|", "|");
    expect(withoutWarning).not.toBe(prompt);
    expect(withoutDeprecated).not.toBe(prompt);
    expect(withoutWarning).not.toMatch(warningContract);
    expect(withoutWarning).toMatch(deprecatedContract);
    expect(withoutDeprecated).not.toMatch(deprecatedContract);
    expect(withoutDeprecated).toMatch(warningContract);
  });

  test("keeps both numbered marker lines in one round-trip, and only what the prompt requests", async () => {
    const originalHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "read-fidelity-wd-"));
    process.env.HOME = testHome;
    const source = [
      "export function legacy() {",
      "  // WARNING: not safe to call before init().",
      "  // DEPRECATED: use modern() instead.",
      "  return 1;",
      "}",
    ].join("\n");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { messages: Array<{ role: string; content: string }> };
        const system = body.messages[0].content;
        const kept = body.messages[1].content.split("\n").flatMap((line, index) => {
          const wanted =
            (/\bWARNING:/.test(line) && warningContract.test(system)) ||
            (/\bDEPRECATED:/.test(line) && deprecatedContract.test(system));
          return wanted ? [`${index + 1}: ${line}`] : [];
        });
        return Response.json({ choices: [{ message: { content: ["Legacy helper.", ...kept].join("\n") } }] });
      },
    });

    try {
      // The summary cache is keyed on input, so vary the source per run.
      let runs = 0;
      const run = (systemPrompt: string) =>
        summarizeIfLarge(`${source}\n// run ${runs++}`, {
          toolName: "ashlr__read",
          systemPrompt,
          thresholdBytes: 1,
          endpointOverride: `http://127.0.0.1:${server.port}/v1`,
        });

      const full = await run(prompt);
      expect(full.text).toContain("2:   // WARNING: not safe to call before init().");
      expect(full.text).toContain("3:   // DEPRECATED: use modern() instead.");

      // Each drop removes only its own line.
      const noWarning = await run(prompt.replace("|WARNING|", "|"));
      expect(noWarning.text).not.toContain("WARNING");
      expect(noWarning.text).toContain("3:   // DEPRECATED: use modern() instead.");
      const noDeprecated = await run(prompt.replace("|DEPRECATED|", "|"));
      expect(noDeprecated.text).not.toContain("DEPRECATED");
      expect(noDeprecated.text).toContain("2:   // WARNING: not safe to call before init().");
    } finally {
      server.stop();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
