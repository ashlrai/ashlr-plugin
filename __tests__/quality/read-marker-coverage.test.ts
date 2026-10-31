import { describe, expect, test } from "bun:test";
import { PROMPTS } from "../../servers/_summarize";

// Only count complete marker names in the verbatim, line-numbered instruction.
function coveredMarkers(prompt: string): string[] {
  const clause = prompt.match(
    /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)*every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/,
  );
  return clause ? clause[1].split("|") : [];
}

describe("read prompt marker coverage", () => {
  const markers = [
    "TODO",
    "FIXME",
    "XXX",
    "HACK",
    "WARNING",
    "THREAD-UNSAFE",
    "DEPRECATED",
    "NOTE",
    "SAFETY",
  ];

  test.each(markers)("preserves every %s marker verbatim with line numbers", (marker) => {
    expect(coveredMarkers(PROMPTS.read)).toContain(marker);

    // An unrelated mention or a longer marker name cannot replace this marker.
    const lookalike = PROMPTS.read.replace(marker, `${marker}-CHECK`);
    expect(lookalike).not.toBe(PROMPTS.read);
    expect(coveredMarkers(`${lookalike} Mention every ${marker} marker;`)).not.toContain(marker);
  });

  test("requires the preservation instruction to apply to every marker", () => {
    for (const weakened of [
      PROMPTS.read.replace("VERBATIM", ""),
      PROMPTS.read.replace("with line numbers", ""),
      PROMPTS.read.replace("every TODO|", "some TODO|"),
    ]) {
      expect(weakened).not.toBe(PROMPTS.read);
      expect(coveredMarkers(weakened)).toEqual([]);
    }
  });
});
