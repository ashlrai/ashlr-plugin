/**
 * Tests for the Q1 Genome 2.0 MVP:
 *   - manifest v1 → v2 auto-upgrade on load (no data loss)
 *   - `git show` fixture parses into a valid CommitSection
 *   - commit pruning at COMMIT_RETENTION_LIMIT (60 commits → 50 kept)
 *   - freshness metadata (lastUpdatedAt, sourceTrust, confidence) on new sections
 *   - ashlr__grep retrieval surfaces commit sections matching a query
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  addCommitSection,
  parseCommitSection,
  pruneCommitSections,
} from "../scripts/genome-commit-watcher";
import {
  COMMITS_SUBDIR,
  COMMIT_RETENTION_LIMIT,
  commitSectionAbsPath,
  loadManifestV2,
  saveManifestV2,
  upgradeManifest,
  writeCommitSectionFile,
  type CommitSection,
  type GenomeManifestV2,
} from "../servers/_manifest-v2";
import {
  formatCommitsForPrompt,
  retrieveCommitSections,
} from "../servers/_genome-commits";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ashlr-genome2-"));
  mkdirSync(join(projectDir, ".ashlrcode", "genome"), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** A v1 manifest exactly as core-efficiency writes it — no schemaVersion, no v2 fields. */
function writeV1Manifest(): void {
  const v1 = {
    version: 1,
    project: "fixture",
    sections: [
      {
        path: "vision/north-star.md",
        title: "North Star",
        summary: "vision",
        tags: ["vision", "north-star"],
        tokens: 30,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        path: "knowledge/decisions.md",
        title: "Decisions",
        summary: "adr",
        tags: ["knowledge", "decisions"],
        tokens: 100,
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
    ],
    generation: { number: 1, milestone: "init", startedAt: "2026-01-01T00:00:00.000Z" },
    fitnessHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(
    join(projectDir, ".ashlrcode", "genome", "manifest.json"),
    JSON.stringify(v1, null, 2),
    "utf-8",
  );
  // section files exist so we don't have a phantom manifest
  mkdirSync(join(projectDir, ".ashlrcode", "genome", "vision"), { recursive: true });
  mkdirSync(join(projectDir, ".ashlrcode", "genome", "knowledge"), { recursive: true });
  writeFileSync(
    join(projectDir, ".ashlrcode", "genome", "vision", "north-star.md"),
    "# vision\n",
    "utf-8",
  );
  writeFileSync(
    join(projectDir, ".ashlrcode", "genome", "knowledge", "decisions.md"),
    "# decisions\n",
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

describe("manifest v1 → v2 migration", () => {
  test("v1 manifest with no schemaVersion auto-upgrades cleanly on load", async () => {
    writeV1Manifest();
    const m = await loadManifestV2(projectDir);
    expect(m).not.toBeNull();
    expect(m!.schemaVersion).toBe(2);
    // v1 canonical fields preserved
    expect(m!.version).toBe(1);
    expect(m!.project).toBe("fixture");
    expect(m!.sections.length).toBe(2);
    // every section got default freshness metadata
    for (const s of m!.sections) {
      expect(s.lastUpdatedAt).toBe(s.updatedAt);
      expect(s.sourceTrust).toBe("static");
      expect(s.kind).toBe("static");
    }
  });

  test("upgrade is idempotent — v2 manifest stays v2 with no data loss", () => {
    const m: GenomeManifestV2 = {
      version: 1,
      schemaVersion: 2,
      project: "fixture",
      sections: [
        {
          path: "x.md",
          title: "x",
          summary: "y",
          tags: [],
          tokens: 5,
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastUpdatedAt: "2026-04-01T00:00:00.000Z",
          sourceTrust: "static",
          kind: "static",
        },
      ],
      generation: { number: 1, milestone: "x", startedAt: "2026-01-01T00:00:00.000Z" },
      fitnessHistory: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const upgraded = upgradeManifest(m);
    expect(upgraded).toBe(m); // same object — no copy
    expect(upgraded.sections[0]!.lastUpdatedAt).toBe("2026-04-01T00:00:00.000Z");
  });

  test("saving a v2 manifest persists schemaVersion=2 on disk", async () => {
    writeV1Manifest();
    const m = await loadManifestV2(projectDir);
    await saveManifestV2(projectDir, m!);
    const raw = JSON.parse(
      readFileSync(join(projectDir, ".ashlrcode", "genome", "manifest.json"), "utf-8"),
    );
    expect(raw.schemaVersion).toBe(2);
    expect(raw.version).toBe(1); // v1 readers still happy
    expect(raw.sections.every((s: { sourceTrust: string }) => typeof s.sourceTrust === "string")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Commit-section production
// ---------------------------------------------------------------------------

describe("parseCommitSection", () => {
  test("parses git show --pretty=fuller + git show --stat into a CommitSection", () => {
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const show =
      "commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n" +
      "Author:     Mason Wyatt <mason@evero-consulting.com>\n" +
      "AuthorDate: Wed May 22 14:31:09 2026 -0700\n" +
      "Commit:     Mason Wyatt <mason@evero-consulting.com>\n" +
      "CommitDate: Wed May 22 14:31:09 2026 -0700\n" +
      "\n" +
      "    feat: ship genome 2.0 mvp\n" +
      "    \n" +
      "    Adds commit-diff awareness to the genome.\n";
    const stat =
      " scripts/genome-commit-watcher.ts | 120 +++++++++++++++++++++\n" +
      " servers/_manifest-v2.ts          |  80 ++++++++++++++\n" +
      " 2 files changed, 200 insertions(+)\n";
    const parsed = parseCommitSection(sha, show, stat);
    expect(parsed.sha).toBe(sha);
    expect(parsed.author).toBe("Mason Wyatt <mason@evero-consulting.com>");
    expect(parsed.date).toMatch(/^2026-05-22T/); // ISO normalized
    expect(parsed.message).toContain("feat: ship genome 2.0 mvp");
    expect(parsed.message).toContain("Adds commit-diff awareness");
    expect(parsed.filesChanged).toEqual([
      "scripts/genome-commit-watcher.ts",
      "servers/_manifest-v2.ts",
    ]);
    expect(parsed.summary).toContain("feat: ship genome 2.0 mvp");
    expect(parsed.summary).toContain("scripts/genome-commit-watcher.ts");
  });
});

describe("addCommitSection", () => {
  test("writes a commit JSON file + upserts manifest entry with freshness metadata", async () => {
    writeV1Manifest();
    const payload: CommitSection = {
      sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      message: "feat: example",
      author: "Tester <t@t.com>",
      date: "2026-05-22T10:00:00.000Z",
      filesChanged: ["a/b.ts"],
      summary: "# feat: example\n\nbody",
    };
    const m = await addCommitSection(projectDir, payload);
    expect(m).not.toBeNull();
    expect(m!.schemaVersion).toBe(2);

    // File written
    const fileAbs = commitSectionAbsPath(projectDir, payload.sha);
    expect(existsSync(fileAbs)).toBe(true);
    const onDisk = JSON.parse(readFileSync(fileAbs, "utf-8"));
    expect(onDisk.sha).toBe(payload.sha);

    // Manifest entry — freshness metadata present + kind=commit
    const entry = m!.sections.find((s) => s.path === `${COMMITS_SUBDIR}/${payload.sha}.json`);
    expect(entry).toBeTruthy();
    expect(entry!.kind).toBe("commit");
    expect(entry!.sourceTrust).toBe("commit");
    expect(typeof entry!.lastUpdatedAt).toBe("string");
    expect(entry!.confidence).toBeGreaterThan(0);
    expect(entry!.confidence).toBeLessThanOrEqual(1);
  });

  test("returns null when no genome exists at cwd", async () => {
    // No manifest written.
    const payload: CommitSection = {
      sha: "ffffffffffffffffffffffffffffffffffffffff",
      message: "m",
      author: "a",
      date: "2026-05-22T00:00:00.000Z",
      filesChanged: [],
      summary: "s",
    };
    const m = await addCommitSection(projectDir, payload);
    expect(m).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

describe("pruneCommitSections", () => {
  test("keeps only the COMMIT_RETENTION_LIMIT most recent when 60 exist", async () => {
    writeV1Manifest();
    // Seed 60 commits with strictly increasing dates so ordering is deterministic.
    const m = (await loadManifestV2(projectDir))!;
    for (let i = 0; i < 60; i++) {
      const sha = `${i.toString().padStart(40, "0")}`;
      const date = new Date(2026, 0, 1 + i).toISOString();
      const payload: CommitSection = {
        sha,
        message: `commit ${i}`,
        author: "test",
        date,
        filesChanged: [`file-${i}.ts`],
        summary: `commit ${i}`,
      };
      const rel = await writeCommitSectionFile(projectDir, payload);
      m.sections.push({
        path: rel,
        title: `commit ${sha.slice(0, 7)} — commit ${i}`,
        summary: `commit ${i}`,
        tags: ["commit", `file-${i}.ts`],
        tokens: 5,
        updatedAt: date,
        lastUpdatedAt: date,
        sourceTrust: "commit",
        kind: "commit",
      });
    }
    expect(m.sections.filter((s) => s.kind === "commit").length).toBe(60);

    const dropped = await pruneCommitSections(projectDir, m);
    expect(dropped.length).toBe(60 - COMMIT_RETENTION_LIMIT);

    const remaining = m.sections.filter((s) => s.kind === "commit");
    expect(remaining.length).toBe(COMMIT_RETENTION_LIMIT);

    // The 10 oldest (i=0..9) should be dropped from disk and manifest.
    for (let i = 0; i < 10; i++) {
      const sha = `${i.toString().padStart(40, "0")}`;
      expect(existsSync(commitSectionAbsPath(projectDir, sha))).toBe(false);
      expect(m.sections.some((s) => s.path.endsWith(`${sha}.json`))).toBe(false);
    }

    // Newest (i=59) survives.
    const newestSha = `${(59).toString().padStart(40, "0")}`;
    expect(m.sections.some((s) => s.path.endsWith(`${newestSha}.json`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ashlr__grep retrieval
// ---------------------------------------------------------------------------

describe("retrieveCommitSections (ashlr__grep wire-up)", () => {
  test("returns commit sections matching a query, formatted distinctly", async () => {
    writeV1Manifest();
    await addCommitSection(projectDir, {
      sha: "1111111111111111111111111111111111111111",
      message: "feat: add manifest v2 schema",
      author: "Tester <t@t.com>",
      date: "2026-05-22T10:00:00.000Z",
      filesChanged: ["servers/_manifest-v2.ts"],
      summary: "# feat: add manifest v2 schema\n\nIntroduces SchemaVersion 2.",
    });
    await addCommitSection(projectDir, {
      sha: "2222222222222222222222222222222222222222",
      message: "chore: bump deps",
      author: "Tester <t@t.com>",
      date: "2026-05-21T10:00:00.000Z",
      filesChanged: ["package.json"],
      summary: "# chore: bump deps\n\nRoutine maintenance.",
    });

    const hits = await retrieveCommitSections(projectDir, "manifest schema", 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.sha.startsWith("1111111")).toBe(true);
    expect(hits[0]!.shortSha).toBe("1111111");
    expect(hits[0]!.score).toBeGreaterThan(0);

    const formatted = formatCommitsForPrompt(hits);
    // v1.30+ Q2 prep — header now includes an optional freshness badge
    // appended after the date. Assert on the stable prefix + suffix.
    expect(formatted).toContain("[commit 1111111 - 2026-05-22");
    expect(formatted).toContain("] feat: add manifest v2 schema");
    expect(formatted).toContain("Commit History");
  });

  test("returns empty when no commit sections exist (v1 backward compat)", async () => {
    writeV1Manifest();
    const hits = await retrieveCommitSections(projectDir, "anything", 5);
    expect(hits).toEqual([]);
  });
});
