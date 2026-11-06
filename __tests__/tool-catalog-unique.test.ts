/**
 * servers/_tool-catalog.json: every entry has a nonempty name, names are unique.
 *
 * Stricter than tool-catalog-unique-names.test.ts: whitespace-only names are
 * rejected, uniqueness is case-insensitive (clients may normalise), and names
 * must be MCP-safe identifiers.
 */

import { describe, expect, test } from "bun:test";
import catalog from "../servers/_tool-catalog.json" with { type: "json" };

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function emptyNameIndexes(tools: readonly { name?: unknown }[]): number[] {
  return tools.flatMap((t, i) => (typeof t.name === "string" && t.name.trim() !== "" ? [] : [i]));
}

function duplicateNames(tools: readonly { name?: unknown }[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const t of tools) {
    const key = String(t.name).toLowerCase();
    if (seen.has(key)) dups.add(key);
    seen.add(key);
  }
  return [...dups];
}

describe("servers/_tool-catalog.json", () => {
  test("has entries", () => {
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);
  });

  test("every entry has a nonempty string name", () => {
    expect(emptyNameIndexes(catalog)).toEqual([]);
  });

  test("names are unique (case-insensitive)", () => {
    expect(duplicateNames(catalog)).toEqual([]);
  });

  test("names are MCP-safe identifiers", () => {
    expect(catalog.map((t) => t.name).filter((n) => !NAME_PATTERN.test(n))).toEqual([]);
  });

  test("checkers catch bad input", () => {
    expect(emptyNameIndexes([{ name: "a" }, { name: "" }, { name: "  " }, {}, { name: 3 }])).toEqual([1, 2, 3, 4]);
    expect(duplicateNames([{ name: "a" }, { name: "A" }, { name: "b" }])).toEqual(["a"]);
  });
});
