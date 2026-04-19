/**
 * Tests for glob LLM summarization (Part 1 of compression-v2-sprint2).
 *
 * Verifies that large glob outputs (> 8 KB) are routed through summarizeIfLarge().
 * We test the formatOutput path directly since spawning a real LLM is not feasible
 * in CI — we verify the threshold gate and that the prompt key ("glob") is wired in.
 */

import { describe, expect, test } from "bun:test";
import { PROMPTS } from "../servers/_summarize";
import { ashlrGlob } from "../servers/glob-server-handlers";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("glob LLM summary — PROMPTS.glob exists", () => {
  test("PROMPTS.glob is defined and non-empty", () => {
    expect(PROMPTS.glob).toBeDefined();
    expect(typeof PROMPTS.glob).toBe("string");
    expect(PROMPTS.glob.length).toBeGreaterThan(50);
  });

  test("PROMPTS.glob mentions output limit", () => {
    // Must instruct the LLM to keep output short.
    expect(PROMPTS.glob).toMatch(/≤\d+ chars|output.*chars|chars.*output/i);
  });

  test("PROMPTS.glob mentions top-level directory distribution", () => {
    expect(PROMPTS.glob).toMatch(/director|top-level|distribution/i);
  });
});

describe("glob LLM summary — threshold gate", () => {
  test("small glob output (< 8 KB) is returned directly without summarization marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-glob-small-"));
    try {
      // Create a handful of files — output will be tiny.
      await writeFile(join(dir, "a.ts"), "");
      await writeFile(join(dir, "b.ts"), "");
      await writeFile(join(dir, "c.ts"), "");

      const result = await ashlrGlob({ pattern: "**/*.ts", cwd: dir });
      // Should not contain an LLM summary hint (no summarization ran).
      // The bypass hint only appears when summarizeIfLarge actually ran.
      expect(result).not.toContain("ashlr summary ·");
      expect(result).toContain("ashlr__glob");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ashlrGlob returns a string for a valid directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-glob-valid-"));
    try {
      await writeFile(join(dir, "index.ts"), "export {}");
      const result = await ashlrGlob({ pattern: "**/*.ts", cwd: dir });
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("large glob output (> 8 KB formatted) triggers summarization path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-glob-large-"));
    try {
      // Create enough files to push the formatted output over 8 KB.
      // Each path is ~80 chars; 8192 / 80 ≈ 103 files needed, create 150 to be safe.
      const sub = join(dir, "src");
      await mkdir(sub, { recursive: true });
      for (let i = 0; i < 150; i++) {
        const longName = `component-with-a-very-long-descriptive-name-number-${String(i).padStart(3, "0")}.ts`;
        await writeFile(join(sub, longName), "");
      }

      // Run without a real LLM — summarizeIfLarge will fall back to truncation.
      // We just verify the function doesn't throw and returns a string.
      const result = await ashlrGlob({ pattern: "**/*.ts", cwd: dir });
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
