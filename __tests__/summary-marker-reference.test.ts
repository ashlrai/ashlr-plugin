import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROMPTS } from "../servers/_summarize";

test("marker reference covers the read prompt's markers with descriptions", () => {
  const markerList = PROMPTS.read.match(/every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/)?.[1];
  expect(markerList).toBeDefined();

  const doc = readFileSync(new URL("../docs/summary-marker-reference.md", import.meta.url), "utf8");
  const rows = [...doc.matchAll(/^\| `([A-Z-]+)` \| ([^|]+) \|$/gm)];
  expect(rows.map((row) => row[1])).toEqual(markerList!.split("|"));
  expect(rows.every((row) => row[2].trim().length > 0)).toBe(true);
  expect(doc).toContain("](../servers/_summarize.ts)");
});
