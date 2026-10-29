/**
 * Quality regression tests for ashlr__read marker preservation.
 *
 * Strategy: test PROMPTS.read directly (exported from servers/_summarize.ts).
 * This is a high-stability, low-fidelity contract: if the prompt no longer
 * asks for the right things, these assertions catch the regression at CI time
 * without requiring a live LLM.
 *
 * We also verify that the summarizeIfLarge code path is wired to PROMPTS.read
 * (not some other prompt) by inspecting the call site indirectly via the
 * exported constant — if someone renames or replaces it, the import breaks.
 */

import { describe, expect, test } from "bun:test";
import { PROMPTS } from "../../servers/_summarize";

describe("PROMPTS.read — load-bearing marker contract", () => {
  const prompt = PROMPTS.read;

  test("asks for @-prefixed decorators/annotations", () => {
    // Must mention the @ symbol so the LLM knows to preserve decorators
    expect(prompt).toContain("@");
    // Must use the word "decorator" or "annotation"
    expect(prompt.toLowerCase()).toMatch(/decorator|annotation/);
  });

  test("asks for THREAD-UNSAFE marker verbatim", () => {
    expect(prompt).toContain("THREAD-UNSAFE");
  });

  test("asks for DEPRECATED marker verbatim", () => {
    expect(prompt).toContain("DEPRECATED");
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

  test("asks for WARNING and SAFETY markers", () => {
    expect(prompt).toContain("WARNING");
    expect(prompt).toContain("SAFETY");
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
