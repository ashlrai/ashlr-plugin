import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROMPTS } from "../servers/_summarize";

test("marker source map tracks the read prompt's complete marker list", () => {
  const markerList = PROMPTS.read.match(/\b([A-Z]+(?:[-|][A-Z]+)+) marker;/)?.[1];
  expect(markerList).toBeDefined();

  const doc = readFileSync(new URL("../docs/summarize-marker-source-map.md", import.meta.url), "utf8");
  const documented = [...doc.matchAll(/^- `([A-Z-]+)`$/gm)].map((match) => match[1]);
  expect(documented).toEqual(markerList!.split("|"));
});

test("marker literals document tracks the read prompt and cites its source", () => {
  const markerList = PROMPTS.read.match(/\b([A-Z]+(?:[-|][A-Z]+)+) marker;/)?.[1];
  expect(markerList).toBeDefined();

  const doc = readFileSync(new URL("../docs/summarize-marker-literals.md", import.meta.url), "utf8");
  const documented = [...doc.matchAll(/^- `([A-Z-]+)`$/gm)].map((match) => match[1]);
  expect(documented).toEqual(markerList!.split("|"));
  expect(doc).toContain("](../servers/_summarize.ts)");
});
