import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { PROMPTS } from "../servers/_summarize";

test("marker maintenance guide links to the instruction and its review resources", () => {
  const doc = readFileSync(new URL("../docs/summary-marker-maintenance.md", import.meta.url), "utf8");
  const links = [...doc.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);

  expect(links).toContain("../servers/_summarize.ts#L123");
  expect(links).toContain("../__tests__/summarize-markers.test.ts");
  expect(links).toContain("../__tests__/quality/read-marker-completeness.test.ts");
  for (const link of links) {
    expect(existsSync(new URL(`../docs/${link.split("#")[0]}`, import.meta.url))).toBe(true);
  }
  const source = readFileSync(new URL("../servers/_summarize.ts", import.meta.url), "utf8");
  expect(source.split("\n")[122].trim()).toBe("read:");

  expect(PROMPTS.read).toContain("Preserve VERBATIM with line numbers:");
  expect(PROMPTS.read).toContain("Do not invent markers that are absent from the source.");
  expect(doc).toContain("bypassSummary:true");
  expect(readFileSync(new URL("../docs/README.md", import.meta.url), "utf8"))
    .toContain("](summary-marker-maintenance.md)");
});
