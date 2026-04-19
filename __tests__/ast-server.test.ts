/**
 * ast-server.test.ts — Track C sprint-1: tree-sitter infrastructure tests.
 *
 * Tests:
 *   - resolveLanguage maps extensions correctly.
 *   - parseFile returns a valid tree for the TS fixture.
 *   - extractIdentifiers returns expected names from the fixture.
 *   - Unsupported extension returns null cleanly.
 *   - Type vs value kind is correctly distinguished.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { resolve } from "path";
import { resolveLanguage, getParser } from "../servers/_ast-languages";
import { parseFile, extractIdentifiers, walkNodes } from "../servers/_ast-helpers";

const FIXTURE_PATH = resolve(import.meta.dir, "fixtures/sample.ts");

// ---------------------------------------------------------------------------
// resolveLanguage
// ---------------------------------------------------------------------------

describe("resolveLanguage", () => {
  test("maps .ts to typescript", () => {
    expect(resolveLanguage("foo.ts")).toBe("typescript");
  });

  test("maps .tsx to tsx", () => {
    expect(resolveLanguage("foo.tsx")).toBe("tsx");
  });

  test("maps .js to javascript", () => {
    expect(resolveLanguage("bar.js")).toBe("javascript");
  });

  test("maps .mjs to javascript", () => {
    expect(resolveLanguage("esm.mjs")).toBe("javascript");
  });

  test("maps .cjs to javascript", () => {
    expect(resolveLanguage("cjs.cjs")).toBe("javascript");
  });

  test("returns null for unknown extension", () => {
    expect(resolveLanguage("style.css")).toBeNull();
    expect(resolveLanguage("Makefile")).toBeNull();
    expect(resolveLanguage("noext")).toBeNull();
  });

  test("accepts bare extension string", () => {
    expect(resolveLanguage(".ts")).toBe("typescript");
  });

  test("is case-insensitive for extension", () => {
    expect(resolveLanguage("FOO.TS")).toBe("typescript");
  });
});

// ---------------------------------------------------------------------------
// getParser (wired languages)
// ---------------------------------------------------------------------------

describe("getParser", () => {
  test("returns a parser for typescript", async () => {
    const parser = await getParser("typescript");
    expect(parser).toBeTruthy();
  });

  test("returns same cached instance on second call", async () => {
    const p1 = await getParser("typescript");
    const p2 = await getParser("typescript");
    expect(p1).toBe(p2);
  });

  test("throws for unwired language (python)", async () => {
    await expect(getParser("python")).rejects.toThrow(/not wired yet/);
  });

  test("throws for unwired language (go)", async () => {
    await expect(getParser("go")).rejects.toThrow(/not wired yet/);
  });

  test("throws for unwired language (rust)", async () => {
    await expect(getParser("rust")).rejects.toThrow(/not wired yet/);
  });
});

// ---------------------------------------------------------------------------
// parseFile
// ---------------------------------------------------------------------------

describe("parseFile", () => {
  test("parses the TS fixture and returns tree + source + lang", async () => {
    const result = await parseFile(FIXTURE_PATH);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe("typescript");
    expect(result!.source).toContain("UserProfile");
    expect(result!.tree).toBeTruthy();
    expect(result!.tree.rootNode).toBeTruthy();
  });

  test("returns null for unsupported extension", async () => {
    const result = await parseFile("/tmp/style.css");
    expect(result).toBeNull();
  });

  test("returns null for unwired language (.py)", async () => {
    // parseFile should handle the getParser throw gracefully and return null.
    const result = await parseFile("/tmp/foo.py");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractIdentifiers — correctness
// ---------------------------------------------------------------------------

describe("extractIdentifiers", () => {
  let names: string[];
  let typeNames: string[];
  let valueNames: string[];

  beforeAll(async () => {
    const result = await parseFile(FIXTURE_PATH);
    expect(result).not.toBeNull();
    const identifiers = extractIdentifiers(result!.tree, result!.source);
    names = identifiers.map((i) => i.name);
    typeNames = identifiers.filter((i) => i.kind === "type").map((i) => i.name);
    valueNames = identifiers.filter((i) => i.kind === "value").map((i) => i.name);
  });

  // Value-position names expected from the fixture.
  // Note: in tree-sitter-typescript, class declaration names are `type_identifier`
  // (not `identifier`) — the class name lives in type position. Function declaration
  // names ARE `identifier` (value position).
  test("extracts class name UserService as type identifier (tree-sitter grammar behaviour)", () => {
    // tree-sitter-typescript tags class names as type_identifier, not identifier.
    expect(typeNames).toContain("UserService");
    expect(valueNames).not.toContain("UserService");
  });

  test("extracts function name createUser as value identifier", () => {
    expect(valueNames).toContain("createUser");
  });

  test("extracts variable defaultAdmin as value identifier", () => {
    expect(valueNames).toContain("defaultAdmin");
  });

  test("extracts method name addUser as value identifier", () => {
    expect(valueNames).toContain("addUser");
  });

  // Type-position names expected from the fixture.
  test("extracts interface name UserProfile as type identifier", () => {
    expect(typeNames).toContain("UserProfile");
  });

  test("extracts type alias UserId as type identifier", () => {
    expect(typeNames).toContain("UserId");
  });

  // range sanity
  test("each identifier has valid byte range", async () => {
    const result = await parseFile(FIXTURE_PATH);
    const identifiers = extractIdentifiers(result!.tree, result!.source);
    for (const id of identifiers) {
      expect(id.range[0]).toBeGreaterThanOrEqual(0);
      expect(id.range[1]).toBeGreaterThan(id.range[0]);
      expect(result!.source.slice(id.range[0], id.range[1])).toBe(id.name);
    }
  });

  test("produces no duplicate (range) entries", async () => {
    const result = await parseFile(FIXTURE_PATH);
    const identifiers = extractIdentifiers(result!.tree, result!.source);
    const keys = identifiers.map((i) => `${i.range[0]}:${i.range[1]}`);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// walkNodes
// ---------------------------------------------------------------------------

describe("walkNodes", () => {
  test("visits all nodes including root", async () => {
    const result = await parseFile(FIXTURE_PATH);
    expect(result).not.toBeNull();
    let count = 0;
    walkNodes(result!.tree, () => { count++; });
    expect(count).toBeGreaterThan(10);
  });

  test("visits nodes with correct type strings", async () => {
    const result = await parseFile(FIXTURE_PATH);
    const types = new Set<string>();
    walkNodes(result!.tree, (n) => types.add(n.type));
    // TS fixture must have identifiers and type_identifiers
    expect(types.has("identifier")).toBe(true);
    expect(types.has("type_identifier")).toBe(true);
  });
});
