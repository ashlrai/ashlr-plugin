import { describe, expect, test } from "bun:test";
import { PROMPTS } from "../servers/_summarize";

describe("read summary marker spellings", () => {
  const markerClause = PROMPTS.read.match(
    /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)*every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/,
  );
  const markers = markerClause?.[1].split("|") ?? [];

  test.each([
    "TODO",
    "FIXME",
    "XXX",
    "HACK",
    "WARNING",
    "THREAD-UNSAFE",
    "DEPRECATED",
    "NOTE",
    "SAFETY",
  ])("requires %s markers verbatim with line numbers", (marker) => {
    expect(markers).toContain(marker);
  });
});
