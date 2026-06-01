/**
 * edit-match.test.ts — direct unit tests for findFuzzyMatch's SAFETY guarantees.
 *
 * findFuzzyMatch backs the fuzzy fallback in ashlr__edit/multi_edit, which
 * applies an edit when exact match fails. It must NEVER return an ambiguous or
 * low-confidence match (that would silently apply an edit in the wrong place).
 * These tests pin the tier boundaries + the uniqueness/confidence guards.
 */
import { describe, expect, test } from "bun:test";
import { findFuzzyMatch } from "../servers/_edit-match";

describe("findFuzzyMatch — tiers + safety guards", () => {
  test("tier 1: whitespace/indentation-normalized unique match maps to real offsets", () => {
    const content = "function foo() {\n    const   x = 1;\n    return x;\n}\n";
    // Differs from the source only by internal whitespace + indentation.
    const m = findFuzzyMatch(content, "const x = 1;");
    expect(m).not.toBeNull();
    const slice = content.slice(m!.start, m!.end);
    expect(slice).toContain("const");
    expect(slice).toContain("x = 1");
    expect(m!.score).toBeGreaterThanOrEqual(0.9);
  });

  test("exact unique substring resolves (score 1.0)", () => {
    const content = "alpha\nbeta\ngamma\n";
    const m = findFuzzyMatch(content, "beta");
    expect(m).not.toBeNull();
    expect(content.slice(m!.start, m!.end)).toContain("beta");
    expect(m!.score).toBe(1.0);
  });

  test("SAFETY: two identical candidate blocks → null (never confidently pick one)", () => {
    const block = "  doThing();\n  doOther();\n  finish();";
    const content = `function a() {\n${block}\n}\n\nfunction b() {\n${block}\n}\n`;
    // Matches both blocks equally — tier1 isn't unique, tier2 margin ~0.
    const m = findFuzzyMatch(content, "doThing();\ndoOther();\nfinish();");
    expect(m).toBeNull();
  });

  test("SAFETY: unrelated search with no plausible match → null", () => {
    const content = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    const m = findFuzzyMatch(content, "completelyUnrelated(zzz, qqq) => banana split");
    expect(m).toBeNull();
  });

  test("SAFETY: a single clearly-closest block resolves; a distant decoy doesn't fool it", () => {
    const content =
      "function pay(amount: number) {\n  validate(amount);\n  charge(amount);\n  receipt(amount);\n}\n\n" +
      "const unrelated = 42;\nconst other = 'xyz';\n";
    // Close to the function body (whitespace/paren drift), far from the decoy lines.
    const m = findFuzzyMatch(
      content,
      "validate(amount);\ncharge(amount);\nreceipt(amount);",
    );
    expect(m).not.toBeNull();
    expect(content.slice(m!.start, m!.end)).toContain("charge(amount)");
    expect(m!.score).toBeGreaterThanOrEqual(0.9);
  });

  test("SAFETY: content over the 2MB limit is skipped → null", () => {
    const big = "x\n".repeat(1_100_000); // ~2.2 MB, over FUZZY_CONTENT_LIMIT
    expect(big.length).toBeGreaterThan(2 * 1024 * 1024);
    const m = findFuzzyMatch(big, "x\nx\nx");
    expect(m).toBeNull();
  });

  test("empty inputs → null", () => {
    expect(findFuzzyMatch("", "foo")).toBeNull();
    expect(findFuzzyMatch("foo", "")).toBeNull();
  });
});
