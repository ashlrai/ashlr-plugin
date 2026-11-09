import { describe, expect, test } from "bun:test";

import { PROMPTS } from "../servers/_summarize";

// Focused guard: the read prompt's VERBATIM marker list must keep HACK and
// DEPRECATED, each as its own whole entry (not a substring of another word).
function markerList(prompt: string): string[] {
  const clause = prompt.match(/every ([A-Z-]+(?:\|[A-Z-]+)+) marker;/);
  expect(clause).not.toBeNull();
  return clause![1]!.split("|");
}

describe("read prompt marker list: HACK and DEPRECATED", () => {
  test.each(["HACK", "DEPRECATED"])("includes %s as a whole entry", (marker) => {
    expect(markerList(PROMPTS.read)).toContain(marker);
  });

  test("lists each marker once", () => {
    const list = markerList(PROMPTS.read);
    expect(new Set(list).size).toBe(list.length);
  });

  test("check fails when HACK or DEPRECATED is dropped", () => {
    const stripped = PROMPTS.read.replace("|HACK|", "|").replace("|DEPRECATED|", "|");
    const list = markerList(stripped);
    expect(list).not.toContain("HACK");
    expect(list).not.toContain("DEPRECATED");
  });
});
