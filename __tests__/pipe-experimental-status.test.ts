import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const doc = read("docs/pipe-experimental-status.md");
const catalog = JSON.parse(read("servers/_tool-catalog.json")) as Array<{
  name: string;
  description: string;
  enableEnv?: string;
  module?: string;
}>;
const pipe = catalog.find((tool) => tool.name === "ashlr__pipe");

describe("pipe experimental status doc", () => {
  test("records the catalog's experimental and default-disabled status", () => {
    expect(pipe).toBeDefined();
    expect(pipe!.description).toContain("[EXPERIMENTAL]");
    expect(doc).toContain("ashlr__pipe");
    expect(doc).toMatch(/experimental/i);
    expect(doc).toMatch(/off by default/i);
    expect(doc).toMatch(/not registered/i);
  });

  test("names the documented enable variable", () => {
    expect(pipe!.enableEnv).toBe("ASHLR_PIPE_ENABLE");
    expect(doc).toContain(pipe!.enableEnv!);
    expect(doc).toContain(`${pipe!.enableEnv}=1`);
    expect(doc).toContain("ASHLR_PIPE_ALLOW_BASH=1");
  });

  test("cites the catalog as the source of truth and is indexed in docs README", () => {
    expect(doc).toContain("../servers/_tool-catalog.json");
    expect(doc).toContain("../servers/_lazy-tools.ts");
    expect(doc).toContain(`\`${pipe!.module}\``);
    expect(doc).toContain("(ashlr-pipe.md)");
    expect(read("docs/README.md")).toContain("(pipe-experimental-status.md)");
  });
});
