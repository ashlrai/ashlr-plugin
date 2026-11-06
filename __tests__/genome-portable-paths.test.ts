import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitSectionPath, discoverySectionPath, parseGenomeSectionKey, COMMIT_RETENTION_LIMIT, DISCOVERY_RETENTION_LIMIT, type GenomeManifestV2 } from "../servers/_manifest-v2";
import { retrieveCommitSections } from "../servers/_genome-commits";
import { retrieveDiscoverySections } from "../servers/_genome-discoveries";
import { pruneCommitSections } from "../scripts/genome-commit-watcher";
import { pruneDiscoverySections } from "../scripts/genome-synthesizer";

test("portable keys and strict legacy parsing", () => {
  for (const dir of ["commits", "discoveries"] as const) {
    expect(parseGenomeSectionKey(`${dir}/old.id-123.json`, dir)).toBe("old.id-123");
    expect(parseGenomeSectionKey(`${dir}\\old.id-123.json`, dir)).toBe("old.id-123");
    for (const device of ["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"]) {
      expect(parseGenomeSectionKey(`${dir}/${device}.json`, dir)).toBeNull();
      expect(parseGenomeSectionKey(`${dir}\\${device}.json`, dir)).toBeNull();
    }
    expect(parseGenomeSectionKey(`${dir}/歴史¹-id.json`, dir)).toBe("歴史¹-id");
    for (const path of [`/${dir}/x.json`, `C:\\${dir}\\x.json`, `other/x.json`, `${dir}/../x.json`, `${dir}\\..\\x.json`, `${dir}/x\\y.json`, `${dir}\\x/y.json`, `${dir}//x.json`, `${dir}/.json`, `${dir}/x`, `${dir}/x:stream.json`, `${dir}/NUL.json`]) {
      expect(parseGenomeSectionKey(path, dir)).toBeNull();
    }
  }
  expect(commitSectionPath("", "abc")).toBe("commits/abc.json");
  expect(discoverySectionPath("", "old-id")).toBe("discoveries/old-id.json");
});

test("legacy retrieval and pruning reject malformed keys and preserve external bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "genome-portable-"));
  try {
    const genome = join(root, ".ashlrcode", "genome");
    for (const dir of ["commits", "discoveries"]) mkdirSync(join(genome, dir), { recursive: true });
    const external = join(genome, "outside.json");
    writeFileSync(external, "external sentinel bytes");
    const sections: any[] = [];
    for (const [dir, kind, limit] of [["commits", "commit", COMMIT_RETENTION_LIMIT], ["discoveries", "discovery", DISCOVERY_RETENTION_LIMIT]] as const) {
      for (let i = 0; i <= limit; i++) {
        const id = `id-${i}`;
        const date = new Date(Date.UTC(2020, 0, i + 1)).toISOString();
        const payload = kind === "commit" ? { sha: id, date, message: "portable", summary: "portable", filesChanged: [] } : { id, synthesizedAt: date, summary: "portable", evidence: [], sourceCommits: [], confidence: 0.8 };
        writeFileSync(join(genome, dir, `${id}.json`), JSON.stringify(payload));
        sections.push({ path: `${dir}${i === 0 ? "\\" : "/"}${id}.json`, kind, title: "portable", summary: "portable", tags: [], tokens: 1, updatedAt: date });
      }
      sections.push({ path: `${dir}/../outside.json`, kind, title: "portable", summary: "portable", tags: [], tokens: 1, updatedAt: "1900" });
      sections.push({ path: `${dir}\\..\\outside.json`, kind, title: "portable", summary: "portable", tags: [], tokens: 1, updatedAt: "1900" });
    }
    const manifest = { version: 1, schemaVersion: 2, sections } as GenomeManifestV2;
    writeFileSync(join(genome, "manifest.json"), JSON.stringify(manifest));
    expect((await retrieveCommitSections(root, "", 100)).some(x => x.sha === "id-0")).toBe(true);
    expect((await retrieveDiscoverySections(root, "", 100)).some(x => x.id === "id-0")).toBe(true);
    expect(await pruneCommitSections(root, manifest)).toEqual(["id-0"]);
    expect(await pruneDiscoverySections(root, manifest)).toEqual(["id-0"]);
    expect(existsSync(join(genome, "commits", "id-0.json"))).toBe(false);
    expect(existsSync(join(genome, "discoveries", "id-0.json"))).toBe(false);
    expect(readFileSync(external, "utf8")).toBe("external sentinel bytes");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
