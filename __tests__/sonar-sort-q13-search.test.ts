import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { summarizeGitStatus, summarizePackageInstall } from "../servers/_bash-summarizers-registry";
import { getGenomeSearchIndex } from "../servers/_genome-search";

describe("Sonar Q13 search and summarizer regressions", () => {
  test("status counts sort by key, including prefix keys", () => {
    expect(summarizeGitStatus("MM both\n M worktree\n?? new\nA  added\n M second", "main"))
      .toBe("??: 1, A: 1, M: 2, MM: 1 · branch main");
    expect(summarizeGitStatus("")).toBe("clean");
  });

  test("package install matches whole emoji and rejects isolated surrogate halves", () => {
    const noise = "Downloading dependency...\n".repeat(12);
    for (const emoji of ["✨", "🚀"]) {
      expect(summarizePackageInstall(noise + `${emoji} Done in 4.12s.`))
        .toBe(`${emoji} Done in 4.12s.`);
    }
    for (const half of ["\uD83D", "\uDE80"]) {
      expect(summarizePackageInstall(noise + `${half} Done in 4.12s.`)).toBeNull();
    }
  });

  test("search preserves code-unit file order and intersects every query token", () => {
    const root = mkdtempSync(join(tmpdir(), "sonar-q13-search-"));
    const dir = join(root, ".ashlrcode", "genome", "knowledge");
    mkdirSync(dir, { recursive: true });
    const index = getGenomeSearchIndex(root);
    try {
      expect(index.lookup("alpha beta")).toEqual([]);
      for (const name of ["zeta.md", "alpha.md", "Zulu.md"]) {
        writeFileSync(join(dir, name), "## Shared\nalpha beta gamma\n");
      }
      writeFileSync(join(dir, "partial.md"), "## Partial\nalpha beta delta\n");
      index.invalidate();
      expect(index.lookup(/Shared/).map((hit) => basename(hit.file)))
        .toEqual(["Zulu.md", "alpha.md", "zeta.md"]);
      expect(index.lookup("alpha beta gamma").map((hit) => basename(hit.file)))
        .toEqual(["Zulu.md", "alpha.md", "zeta.md"]);
      expect(index.lookup("alpha beta")).toHaveLength(4);
      expect(index.lookup("gamma delta")).toEqual([]);
      expect(index.lookup("alpha absent")).toEqual([]);
      expect(index.lookup("absent alpha")).toEqual([]);
      expect(index.lookup("alpha beta absent")).toEqual([]);
    } finally {
      index.invalidate();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
