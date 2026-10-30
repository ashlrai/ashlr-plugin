/**
 * Quality regression tests for ashlr__read marker preservation.
 *
 * Strategy: test PROMPTS.read directly (exported from servers/_summarize.ts).
 * This is a high-stability, low-fidelity contract: if the prompt no longer
 * asks for the right things, these assertions catch the regression at CI time
 * without requiring a live LLM.
 */

import { describe, expect, test } from "bun:test";
import { PROMPTS } from "../../servers/_summarize";

describe("PROMPTS.read — load-bearing marker contract", () => {
  const prompt = PROMPTS.read;
  const noteContract =
    /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*NOTE(?:\|[A-Z-]+)* marker;/;

  test("asks for @-prefixed decorators/annotations", () => {
    // Must mention the @ symbol so the LLM knows to preserve decorators
    expect(prompt).toContain("@");
    // Must use the word "decorator" or "annotation"
    expect(prompt.toLowerCase()).toMatch(/decorator|annotation/);
  });

  test("requests verbatim THREAD-UNSAFE markers with line numbers", () => {
    expect(prompt).toMatch(
      /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*THREAD-UNSAFE(?:\|[A-Z-]+)* marker;/,
    );
  });

  test("asks for DEPRECATED marker verbatim", () => {
    expect(prompt).toContain("DEPRECATED");
  });

  test("requests preservation of DEPRECATED markers with line numbers", () => {
    const deprecatedContract =
      /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*DEPRECATED(?:\|[A-Z-]+)* marker;/;
    expect(prompt).toMatch(deprecatedContract);

    // A mention outside the preservation clause must not satisfy the contract.
    const withoutDeprecated = prompt.replace("DEPRECATED|", "");
    expect(withoutDeprecated).not.toMatch(deprecatedContract);
    expect(`${withoutDeprecated} Mention every DEPRECATED marker;`).not.toMatch(deprecatedContract);
    expect(prompt.replace("with line numbers", "")).not.toMatch(deprecatedContract);
  });

  test("requests preservation of TODO markers with line numbers", () => {
    expect(prompt).toMatch(/Preserve VERBATIM with line numbers:[\s\S]*?\bTODO(?:\|[A-Z-]+)* marker/);
  });

  test("asks for TODO|FIXME markers", () => {
    expect(prompt).toMatch(/TODO/);
    expect(prompt).toMatch(/FIXME/);
  });

  test("asks for XXX marker verbatim", () => {
    expect(prompt).toContain("XXX");
    expect(prompt).toMatch(
      /Preserve VERBATIM with line numbers:[\s\S]*?\bevery (?:[A-Z-]+\|)*XXX(?:\|[A-Z-]+)* marker;/,
    );
  });

  test("asks for HACK marker verbatim", () => {
    expect(prompt).toContain("HACK");
  });

  test("requests preservation of NOTE markers with line numbers", () => {
    expect(prompt).toMatch(noteContract);

    // A mention outside the preservation clause must not satisfy the contract.
    const withoutNote = prompt.replace("|NOTE|", "|");
    expect(withoutNote).not.toMatch(noteContract);
    expect(`${withoutNote} Mention every NOTE marker;`).not.toMatch(noteContract);
    expect(prompt.replace("with line numbers", "")).not.toMatch(noteContract);
  });

  test("requires NOTE as a complete marker, not part of another word", () => {
    for (const lookalike of ["NOTED", "NOTEBOOK", "FOOTNOTE"]) {
      const mutatedPrompt = prompt.replace(/\bNOTE\b/, lookalike);
      expect(mutatedPrompt).not.toBe(prompt);
      expect(mutatedPrompt).not.toMatch(noteContract);
    }
  });

  test("asks for WARNING and SAFETY markers", () => {
    expect(prompt).toContain("WARNING");
    expect(prompt).toContain("SAFETY");
  });

  test("requests verbatim SAFETY markers with line numbers", () => {
    expect(prompt).toMatch(
      /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)?every (?:[A-Z-]+\|)*SAFETY(?:\|[A-Z-]+)* marker;/,
    );
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
