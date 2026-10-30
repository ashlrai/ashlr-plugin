import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getGenomeSearchIndex } from "../servers/_genome-search";
import { buildProduct, generatedFiles } from "../site/scripts/freshness";

describe("Sonar Q8 batch 6 regressions", () => {
  test("hook trampoline forwards option-shaped arguments and preserves blocking exit", () => {
    const home = mkdtempSync(join(tmpdir(), "sonar-q8-6-hook-"));
    const hook = join(home, "hook.ts");
    const args = ["--eval", "literal;$value", "with spaces"];
    writeFileSync(hook, 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(2);');
    try {
      const result = spawnSync(Bun.which("node")!, [join(import.meta.dir, "../scripts/hook-bootstrap.mjs"), hook, ...args], {
        encoding: "utf8",
        env: { PATH: dirname(process.execPath), HOME: home, USERPROFILE: home },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout.trim())).toEqual(args);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("multi-token lookup intersects every posting list, including absent and repeated tokens", () => {
    const root = mkdtempSync(join(tmpdir(), "sonar-q8-6-index-"));
    const dir = join(root, ".ashlrcode/genome/knowledge");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of [
      ["zebra.md", "## Partial\nalpha beta"],
      ["Alpha.md", "## Complete\nalpha beta gamma"],
      ["apple.md", "## Other\nbeta gamma"],
    ]) writeFileSync(join(dir, name!), body!);
    try {
      const index = getGenomeSearchIndex(root);
      expect(index.lookup("alpha beta gamma").map((hit) => hit.section)).toEqual(["Complete"]);
      expect(index.lookup("gamma alpha beta alpha").map((hit) => hit.section)).toEqual(["Complete"]);
      expect(index.lookup("alpha absent")).toEqual([]);
      expect(index.lookup("absent alpha")).toEqual([]);
      expect(index.lookup("!")).toEqual([]);
      expect(index.lookup(/beta/).map((hit) => hit.file.split("/").pop())).toEqual(["Alpha.md", "apple.md", "zebra.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("generated skill navigation remains unique and uses the existing string order", () => {
    const product = buildProduct();
    const expected = [...new Set([...product.commands, ...product.workflowSkills]
      .map((surface) => surface.name.replace(/^ashlr-/, "")))].sort();
    const meta = JSON.parse(generatedFiles().get("site/content/docs/skills/meta.json")!);
    expect(meta.pages).toEqual(["index", ...expected]);
  });
});
