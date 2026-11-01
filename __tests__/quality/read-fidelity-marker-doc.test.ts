import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROMPTS } from "../../servers/_summarize";

test("read fidelity documentation tracks the shared marker list", () => {
  const clause = PROMPTS.read.match(
    /Preserve VERBATIM with line numbers:[\s\S]*?every ([A-Z-]+(?:\|[A-Z-]+)*) marker;/,
  );
  expect(clause).not.toBeNull();

  const doc = readFileSync(new URL("../../docs/read-fidelity-marker-assertions.md", import.meta.url), "utf8");
  const documented = [...doc.matchAll(/^- `([A-Z-]+)`$/gm)].map((match) => match[1]);
  expect(documented).toEqual(clause![1].split("|"));
});
