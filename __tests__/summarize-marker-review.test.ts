import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROMPTS } from "../servers/_summarize";

test("review guide lists the read prompt's markers in order", () => {
  const markerList = PROMPTS.read.match(/\b([A-Z]+(?:[-|][A-Z]+)+) marker;/)?.[1];
  expect(markerList).toBeDefined();

  const doc = readFileSync(new URL("../docs/summarize-marker-review.md", import.meta.url), "utf8");
  const documented = [...doc.matchAll(/^- `([A-Z-]+)`$/gm)].map((match) => match[1]);
  expect(documented).toEqual(markerList!.split("|"));
  expect(doc).toContain("](../servers/_summarize.ts)");
});
