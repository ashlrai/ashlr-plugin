import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { PROMPTS } from "../servers/_summarize";

// docs/summary-markers.md absorbed eight overlapping marker notes, each with
// its own test. This file carries their checks against the one remaining
// note so the inventory cannot drift between copies.
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const doc = read("docs/summary-markers.md");

const markerList = (): string[] => {
  const clause = PROMPTS.read.match(
    /Preserve VERBATIM with line numbers:[\s\S]*?every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/,
  );
  expect(clause).not.toBeNull();
  return clause![1].split("|");
};

describe("docs/summary-markers.md tracks PROMPTS.read", () => {
  test("the table lists the prompt's markers in order, each with a description", () => {
    const rows = [...doc.matchAll(/^\| `([A-Z-]+)` \| ([^|]+) \|$/gm)];
    expect(rows.map((row) => row[1])).toEqual(markerList());
    expect(rows.every((row) => row[2].trim().length > 0)).toBe(true);
  });

  test("the example block shows each marker once, in prompt order", () => {
    const block = doc.match(/```ts\n([\s\S]*?)\n```/);
    expect(block).not.toBeNull();
    const examples = block![1].split("\n").map((line) => line.match(/^\/\/ ([A-Z-]+): (.+)$/));
    expect(examples.every((example) => example !== null)).toBe(true);
    expect(examples.map((example) => example![1])).toEqual(markerList());
  });

  test("the cited prompt line and the facts the note relies on are current", () => {
    expect(read("servers/_summarize.ts").split("\n")[122].trim()).toBe("read:");
    expect(PROMPTS.read).toContain("Do not invent markers that are absent from the source.");
    expect(PROMPTS.read).toContain("Output ≤500 chars.");
    expect(PROMPTS.read).toContain("(@deprecated");
    expect(doc).toContain("bypassSummary:true");
  });

  test("links point at the source and the guarding tests, and resolve", () => {
    const links = [...doc.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
    for (const expected of [
      "../servers/_summarize.ts#L123",
      "../__tests__/summarize-markers.test.ts",
      "../__tests__/quality/read-marker-completeness.test.ts",
      "../__tests__/quality/read-fidelity.test.ts",
      "../__tests__/summary-markers-doc.test.ts",
    ]) {
      expect(links).toContain(expected);
    }
    for (const link of links) {
      expect(existsSync(new URL(`../docs/${link.split("#")[0]}`, import.meta.url))).toBe(true);
    }
  });

  test("is reachable from the docs index", () => {
    expect(read("docs/README.md")).toContain("](summary-markers.md)");
  });
});

describe("superseded marker notes stay consolidated", () => {
  const superseded = [
    "summarize-marker-examples.md",
    "summarize-marker-literals.md",
    "summarize-marker-purpose.md",
    "summarize-marker-review.md",
    "summarize-marker-source-map.md",
    "summary-marker-maintenance.md",
    "summary-marker-reference.md",
    "read-fidelity-marker-assertions.md",
  ];

  test.each(superseded)("%s is deleted", (stale) =>
    expect(existsSync(new URL(`../docs/${stale}`, import.meta.url))).toBe(false),
  );

  test.each(superseded)("docs index does not link %s", (stale) =>
    expect(read("docs/README.md")).not.toContain(stale),
  );
});
