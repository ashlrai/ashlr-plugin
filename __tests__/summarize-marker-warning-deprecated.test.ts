import { describe, expect, test } from "bun:test";

import { PROMPTS } from "../servers/_summarize";

// Regression guard: the read prompt's marker list must keep WARNING and
// DEPRECATED so summaries preserve them verbatim.
function markerList(): string[] {
  const clause = PROMPTS.read.match(/every ([A-Z-]+(?:\|[A-Z-]+)+) marker;/);
  expect(clause).not.toBeNull();
  return clause![1]!.split("|");
}

describe("read prompt marker list", () => {
  test.each(["WARNING", "DEPRECATED"])("includes %s", (marker) => {
    expect(markerList()).toContain(marker);
  });

  test("detection fails when a marker is dropped", () => {
    const stripped = PROMPTS.read.replace("|WARNING|", "|").replace("|DEPRECATED|", "|");
    const list = stripped.match(/every ([A-Z-]+(?:\|[A-Z-]+)+) marker;/)![1]!.split("|");
    expect(list).not.toContain("WARNING");
    expect(list).not.toContain("DEPRECATED");
  });
});
