import { describe, expect, test } from "bun:test";
import { PROMPTS } from "../../servers/_summarize";

// Restrict the check to the instruction that requires verbatim, line-numbered
// preservation, so an incidental mention of a marker does not satisfy it.
function preservedMarkers(prompt: string): string[] {
  const clause = prompt.match(
    /Preserve VERBATIM with line numbers:\s*(?:[^;]*;\s*)*every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/,
  );
  return clause?.[1].split("|") ?? [];
}

describe("read prompt safety markers", () => {
  test.each(["SAFETY", "THREAD-UNSAFE"])(
    "requires every %s marker verbatim with line numbers",
    (marker) => {
      expect(preservedMarkers(PROMPTS.read)).toContain(marker);

      const lookalike = PROMPTS.read.replace(marker, `${marker}-CHECK`);
      expect(lookalike).not.toBe(PROMPTS.read);
      expect(preservedMarkers(`${lookalike} Mention ${marker} markers.`)).not.toContain(marker);
    },
  );
});
