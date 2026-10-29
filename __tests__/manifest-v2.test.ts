import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitSectionAbsPath, commitSectionPath, readCommitSectionFile, writeCommitSectionFile,
  discoverySectionAbsPath, discoverySectionPath, readDiscoverySectionFile, writeDiscoverySectionFile,
  prSectionAbsPath, prSectionPath, readPrSectionFile, writePrSectionFile,
  issueSectionAbsPath, issueSectionPath, readIssueSectionFile, writeIssueSectionFile,
  loadManifestV2, saveManifestV2, upgradeManifest, type GenomeManifestV2,
} from "../servers/_manifest-v2";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "ashlr-manifest-v2-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

function manifest(): GenomeManifestV2 {
  return {
    version: 1, project: "fixture", sections: [], fitnessHistory: [],
    generation: { number: 1, milestone: "init", startedAt: "2026-01-01T00:00:00.000Z" },
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

// Exercise each public helper against real files, including a second write
// after its directory exists. Readers must tolerate interrupted JSON writes.
const sectionCases = [
  {
    name: "commit", relative: join("commits", "abc.json"),
    path: commitSectionPath, absPath: commitSectionAbsPath, read: readCommitSectionFile,
    write: (root: string) => writeCommitSectionFile(root, {
      sha: "abc", message: "Fix parser", author: "fixture", date: "2026-01-01",
      filesChanged: ["parser.ts"], summary: "Handle incomplete input",
    }),
    id: "abc", expected: { sha: "abc", summary: "Handle incomplete input" },
  },
  {
    name: "discovery", relative: join("discoveries", "abc.json"),
    path: discoverySectionPath, absPath: discoverySectionAbsPath, read: readDiscoverySectionFile,
    write: (root: string) => writeDiscoverySectionFile(root, {
      id: "abc", summary: "Shared parser", evidence: [{ path: "parser.ts", lineRange: [1, 3] }],
      sourceCommits: ["def"], synthesizedAt: "2026-01-01", confidence: 0.8,
    }),
    id: "abc", expected: { id: "abc", confidence: 0.8 },
  },
  {
    name: "PR", relative: join("sections", "prs", "42.json"),
    path: prSectionPath, absPath: prSectionAbsPath, read: readPrSectionFile,
    write: (root: string) => writePrSectionFile(root, {
      id: "42", title: "Fix parser", mergedAt: "2026-01-01", author: "fixture",
      filesChanged: ["parser.ts"], summary: "Handle incomplete input", url: "https://example.test/pull/42",
    }),
    id: "42", expected: { id: "42", filesChanged: ["parser.ts"] },
  },
  {
    name: "issue", relative: join("sections", "issues", "42.json"),
    path: issueSectionPath, absPath: issueSectionAbsPath, read: readIssueSectionFile,
    write: (root: string) => writeIssueSectionFile(root, {
      id: "42", title: "Parser bug", closedAt: "2026-01-01", author: "fixture",
      labels: ["bug"], summary: "Incomplete input", url: "https://example.test/issues/42",
    }),
    id: "42", expected: { id: "42", labels: ["bug"] },
  },
];

for (const section of sectionCases) {
  describe(`${section.name} section persistence`, () => {
    test("round-trips the full payload and returns a genome-relative path", async () => {
      expect(await section.read(cwd, section.id)).toBeNull();
      expect(section.path(cwd, section.id)).toBe(section.relative);
      const abs = section.absPath(cwd, section.id);
      expect(abs).toBe(join(cwd, ".ashlrcode", "genome", section.relative));
      for (let i = 0; i < 2; i++) {
        expect(await section.write(cwd)).toBe(section.relative);
        const stored = JSON.parse(readFileSync(abs, "utf8"));
        expect(stored).toMatchObject(section.expected);
        expect(await section.read(cwd, section.id)).toEqual(stored);
      }
    });

    test("corrupt JSON is treated as missing without modifying the file", async () => {
      await section.write(cwd);
      const abs = section.absPath(cwd, section.id);
      writeFileSync(abs, '{"partial":');
      expect(await section.read(cwd, section.id)).toBeNull();
      expect(readFileSync(abs, "utf8")).toBe('{"partial":');
    });
  });
}

describe("manifest persistence and migration", () => {
  test("v1 upgrade preserves canonical fields and explicit freshness without mutating input", () => {
    const base = { path: "x.md", title: "x", summary: "x", tags: ["test"], tokens: 1, updatedAt: "2026-01-01" };
    const m: GenomeManifestV2 = { ...manifest(), sections: [
      { ...base },
      { ...base, kind: "issue", sourceTrust: "issue", lastUpdatedAt: "2026-02-01", confidence: 0.7 },
    ] };
    const original = structuredClone(m);
    const upgraded = upgradeManifest(m);
    expect(m).toEqual(original);
    expect(upgraded).toEqual({ ...original, schemaVersion: 2, sections: [
      { ...base, kind: "static", sourceTrust: "static", lastUpdatedAt: base.updatedAt },
      original.sections[1]!,
    ] });
  });

  test("missing, corrupt and malformed manifests are treated as missing", async () => {
    expect(await loadManifestV2(cwd)).toBeNull();
    const dir = join(cwd, ".ashlrcode", "genome");
    mkdirSync(dir, { recursive: true });
    for (const raw of ['{"partial":', "null", '{"version":1}']) {
      writeFileSync(join(dir, "manifest.json"), raw);
      expect(await loadManifestV2(cwd)).toBeNull();
    }
  });

  test("save creates directories, refreshes timestamps and loads as v2", async () => {
    const m = manifest();
    const before = Date.now();
    await saveManifestV2(cwd, m);
    expect(m.schemaVersion).toBe(2);
    expect(Date.parse(m.updatedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(m.updatedAt)).toBeLessThanOrEqual(Date.now());
    expect(await loadManifestV2(cwd)).toEqual(m);
    expect(existsSync(join(cwd, ".ashlrcode", "genome", "manifest.json.tmp"))).toBe(false);
  });

  test("failed rename removes the temporary file and preserves the target", async () => {
    const target = join(cwd, ".ashlrcode", "genome", "manifest.json");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "sentinel"), "keep");
    await expect(saveManifestV2(cwd, manifest())).rejects.toThrow();
    expect(existsSync(target + ".tmp")).toBe(false);
    expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("keep");
  });

  test("failed temporary write preserves the previous manifest", async () => {
    await saveManifestV2(cwd, manifest());
    const target = join(cwd, ".ashlrcode", "genome", "manifest.json");
    const previous = readFileSync(target, "utf8");
    mkdirSync(target + ".tmp");
    await expect(saveManifestV2(cwd, manifest())).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe(previous);
  });

  test("old v2 sections gain defaults while explicit provenance survives", () => {
    const base = { path: "x.md", title: "x", summary: "x", tags: [], tokens: 1, updatedAt: "2026-01-01" };
    const m: GenomeManifestV2 = { ...manifest(), schemaVersion: 2, sections: [
      { ...base }, { ...base, kind: "commit" },
      { ...base, kind: "discovery", sourceTrust: "synthesis", confidence: 0.9, lastUpdatedAt: "2026-02-01" },
    ] };
    expect(upgradeManifest(m)).toBe(m);
    expect(m.sections[0]).toMatchObject({ kind: "static", sourceTrust: "static", lastUpdatedAt: base.updatedAt });
    expect(m.sections[1]).toMatchObject({ kind: "commit", sourceTrust: "commit", lastUpdatedAt: base.updatedAt });
    expect(m.sections[2]).toMatchObject({ kind: "discovery", sourceTrust: "synthesis", confidence: 0.9, lastUpdatedAt: "2026-02-01" });
    const upgraded = structuredClone(m);
    expect(upgradeManifest(m)).toEqual(upgraded);
  });
});
