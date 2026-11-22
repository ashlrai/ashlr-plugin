import { describe, expect, test } from "bun:test";
import {
  GENOME_ID_PATTERN,
  assertGenomeId,
  genomeIdPathSegment,
  isSafeGenomeId,
} from "../servers/_genome-id.ts";

describe("GENOME_ID_PATTERN", () => {
  test("is anchored: a trailing newline does not slip past the character class", () => {
    expect(GENOME_ID_PATTERN.test("abc")).toBe(true);
    // JS `$` without the m flag matches only at end of input, so "\n" fails.
    expect(GENOME_ID_PATTERN.test("abc\n")).toBe(false);
  });
});

describe("isSafeGenomeId", () => {
  test("accepts server-issued uuid/nanoid-style ids, including the 128-char limit", () => {
    for (const good of ["genome-xyz", "abc_123", "g_9f2.k", "A1", "a".repeat(128)]) {
      expect(isSafeGenomeId(good)).toBe(true);
    }
  });

  test("edge: rejects an id one character over the 128-char limit and the empty id", () => {
    expect(isSafeGenomeId("a".repeat(129))).toBe(false);
    expect(isSafeGenomeId("")).toBe(false);
  });

  test("rejects the dot-segment ids '.' and '..' that would resolve to a parent or self path", () => {
    expect(isSafeGenomeId(".")).toBe(false);
    expect(isSafeGenomeId("..")).toBe(false);
    expect(isSafeGenomeId("../escape")).toBe(false);
  });

  test("rejects path separators and URL metacharacters", () => {
    for (const bad of ["a/b", "a\\b", "x?y=1", "x#f", "x@h", "x%2f", "x y"]) {
      expect(isSafeGenomeId(bad)).toBe(false);
    }
  });

  test("error path: non-string input returns false instead of throwing", () => {
    for (const bad of [undefined, null, 42, ["abc"], { id: "abc" }]) {
      expect(isSafeGenomeId(bad)).toBe(false);
    }
  });
});

describe("assertGenomeId", () => {
  test("returns the id unchanged when it is safe", () => {
    expect(assertGenomeId("genome-xyz")).toBe("genome-xyz");
  });

  test("error path: throws the documented error for unsafe and non-string input", () => {
    for (const bad of ["../x", "", "a".repeat(129), undefined, 7]) {
      expect(() => assertGenomeId(bad)).toThrow("genomeId is not a safe identifier");
    }
  });
});

describe("genomeIdPathSegment", () => {
  test("returns a safe id as an encoded path segment (identity for pattern characters)", () => {
    expect(genomeIdPathSegment("g_9f2.k-1")).toBe("g_9f2.k-1");
    expect(genomeIdPathSegment("g_9f2.k-1")).toBe(encodeURIComponent("g_9f2.k-1"));
  });

  test("error path: throws for traversal and URL-rewriting ids instead of encoding them", () => {
    for (const bad of ["..", "a/b", "x?y=1", "x#f"]) {
      expect(() => genomeIdPathSegment(bad)).toThrow("genomeId is not a safe identifier");
    }
  });

  test("never produces a segment containing a path or query delimiter", () => {
    for (const good of ["a", "A.b_c-d", "x".repeat(128)]) {
      const seg = genomeIdPathSegment(good);
      expect(seg).not.toMatch(/[/?#]/);
    }
  });
});
