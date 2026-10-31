import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applySearchReplaceRegexPlan,
  ashlrSearchReplaceRegex,
  planSearchReplaceRegex,
} from "../servers/search-replace-regex-server";

const originalCwd = process.cwd();
let project: string;

beforeEach(async () => {
  project = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-srr-no-match-")));
  process.chdir(project);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(project, { recursive: true, force: true });
});

describe("regex search and replace with no matches", () => {
  test("reports zero replacements and preserves the fixture in dry run and apply", async () => {
    const file = join(project, "fixture.txt");
    const original = Buffer.from("café\r\nitem=12x\nitem=x34\n", "utf-8");
    await writeFile(file, original);
    const args = { pattern: "^item=\\d+$", replacement: "item=0", flags: "m", roots: [file] };

    for (const dryRun of [true, false]) {
      const result = await ashlrSearchReplaceRegex({ ...args, dryRun });
      expect(result.text).toContain("0 files, 0 replacements");
      expect(result.text).not.toContain("warnings:");
      expect(result.originalBytes).toBe(0);
      expect(result.newBytes).toBe(0);
      expect(await readFile(file)).toEqual(original);
    }
  });

  test("does not write a planned file if its match disappears before apply", async () => {
    const file = join(project, "fixture.txt");
    await writeFile(file, "item=123\n");
    const args = { pattern: "^item=\\d+$", replacement: "item=0", flags: "m", roots: [file] };
    const planned = await planSearchReplaceRegex(args);
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.reason);
    expect(planned.plan.files).toHaveLength(1);

    const changed = Buffer.from("item=12x\r\nkeep café\n", "utf-8");
    await writeFile(file, changed);
    const applied = await applySearchReplaceRegexPlan(planned.plan, args);

    expect(applied).toEqual({
      written: 0,
      totalReplacements: 0,
      totalOriginalBytes: 0,
      totalNewBytes: 0,
      rollbackWarnings: [],
    });
    expect(await readFile(file)).toEqual(changed);
  });
});
