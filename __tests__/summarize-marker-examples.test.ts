import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROMPTS } from "../servers/_summarize";

test("marker examples cover the read prompt's list once each", () => {
  const clause = PROMPTS.read.match(/every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/);
  expect(clause).not.toBeNull();

  const doc = readFileSync(new URL("../docs/summarize-marker-examples.md", import.meta.url), "utf8");
  const block = doc.match(/```ts\n([\s\S]*?)\n```/);
  expect(block).not.toBeNull();
  const comments = block![1].split("\n");
  const examples = comments.map((comment) => comment.match(/^\/\/ ([A-Z-]+): (.+)$/));
  expect(examples.every((example) => example !== null)).toBe(true);
  expect(examples.map((example) => example![1])).toEqual(clause![1].split("|"));
  expect(doc).toContain("](../servers/_summarize.ts)");
});
