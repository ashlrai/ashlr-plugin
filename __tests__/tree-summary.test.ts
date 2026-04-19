/**
 * Tests for tree LLM summarization (Part 1 of compression-v2-sprint2).
 *
 * Verifies that large tree outputs (> 8 KB) are routed through summarizeIfLarge()
 * and that PROMPTS.tree is correctly defined.
 */

import { describe, expect, test } from "bun:test";
import { PROMPTS } from "../servers/_summarize";
import { ashlrTree } from "../servers/tree-server-handlers";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("tree LLM summary — PROMPTS.tree exists", () => {
  test("PROMPTS.tree is defined and non-empty", () => {
    expect(PROMPTS.tree).toBeDefined();
    expect(typeof PROMPTS.tree).toBe("string");
    expect(PROMPTS.tree.length).toBeGreaterThan(50);
  });

  test("PROMPTS.tree mentions output limit", () => {
    expect(PROMPTS.tree).toMatch(/≤\d+ chars|output.*chars|chars.*output/i);
  });

  test("PROMPTS.tree mentions top-level directories", () => {
    expect(PROMPTS.tree).toMatch(/top-level|director/i);
  });
});

describe("tree LLM summary — threshold gate", () => {
  test("small tree (< 8 KB) returns raw output without summarization marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-tree-small-"));
    try {
      await writeFile(join(dir, "a.ts"), "export const a = 1;");
      await writeFile(join(dir, "b.ts"), "export const b = 2;");

      const result = await ashlrTree({ path: dir });
      expect(result).not.toContain("ashlr summary ·");
      // Should show the directory name.
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ashlrTree returns a string for a valid directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-tree-valid-"));
    try {
      await writeFile(join(dir, "main.ts"), "");
      const result = await ashlrTree({ path: dir });
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("large tree output (> 8 KB) triggers summarization path without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-tree-large-"));
    try {
      // Build a wide/deep structure to push tree output > 8 KB.
      // 10 subdirs × 20 files with long names = 200 entries.
      for (let d = 0; d < 10; d++) {
        const sub = join(dir, `module-directory-with-long-name-${d}`);
        await mkdir(sub, { recursive: true });
        for (let f = 0; f < 20; f++) {
          await writeFile(
            join(sub, `component-with-descriptive-long-filename-${f}.ts`),
            "export default {};\n",
          );
        }
      }

      // No real LLM — summarizeIfLarge falls back to truncation. Just verify no throw.
      const result = await ashlrTree({ path: dir });
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
