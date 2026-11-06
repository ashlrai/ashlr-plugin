import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ashlrSearchReplaceRegex } from "../servers/search-replace-regex-server";

const originalCwd = process.cwd();
let tmpProj: string;

beforeEach(async () => {
  tmpProj = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-original-724-")));
  process.chdir(tmpProj);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpProj, { recursive: true, force: true });
});

describe("original 724 search and replace assertions", () => {
  test("inserts exactly two literal dollar signs via $$$$", async () => {
    const file = join(tmpProj, "double-dollar.txt");
    await writeFile(file, "price: PLACEHOLDER\nnote: PLACEHOLDER!\n");

    const args = { pattern: "PLACEHOLDER", replacement: "$$$$" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("price: PLACEHOLDER\nnote: PLACEHOLDER!\n");

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    const after = await readFile(file, "utf-8");
    // Each match becomes two dollar signs, no more and no fewer.
    expect(after).toBe("price: $$\nnote: $$!\n");
    for (const line of after.split("\n").filter(Boolean)) {
      expect(line.split("$").length - 1).toBe(2);
    }
  });

});
