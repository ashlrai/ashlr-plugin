import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../.devin/wiki.json", import.meta.url), "utf8"));

describe("DeepWiki configuration", () => {
  test("provides repository context and a usable page outline", () => {
    expect(Array.isArray(config.repo_notes)).toBe(true);
    expect(config.repo_notes.length).toBeGreaterThan(0);
    for (const note of config.repo_notes) {
      expect(typeof note.content).toBe("string");
      expect(note.content.trim().length).toBeGreaterThan(0);
      expect(note.content.length).toBeLessThanOrEqual(10_000);
    }

    expect(Array.isArray(config.pages)).toBe(true);
    expect(config.pages.length).toBeGreaterThan(0);
    expect(config.pages.length).toBeLessThanOrEqual(30);
    const titles = new Set<string>();
    for (const page of config.pages) {
      expect(typeof page.title).toBe("string");
      expect(page.title.trim().length).toBeGreaterThan(0);
      expect(typeof page.purpose).toBe("string");
      expect(page.purpose.trim().length).toBeGreaterThan(0);
      expect(titles.has(page.title)).toBe(false);
      titles.add(page.title);
    }
  });

  test("frames the repo within the Ashlr ecosystem", () => {
    const notes = config.repo_notes.map((note: { content: string }) => note.content).join("\n");
    expect(notes).toContain("Phantom");
    expect(notes).toContain("AGENTS.md");
    expect(notes).toContain("--ashlr-handshake");
    expect(config.pages.some((page: { title: string }) => page.title === "Ashlr Ecosystem and Agent Workflow")).toBe(true);
  });
});
