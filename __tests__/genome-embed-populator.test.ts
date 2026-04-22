/**
 * genome-embed-populator.test.ts — Wiring test for the placebo-to-real
 * embedding-cache fix.
 *
 * Verifies:
 *   1. First populate on a fresh genome upserts one embedding per section.
 *   2. A follow-up `searchSimilar` for one of the section titles returns that
 *      section as the top hit (proves cache is queryable + ranked).
 *   3. Re-running populate with the manifest mtime unchanged is a no-op.
 *   4. Touching the manifest invalidates the watermark and re-embeds only the
 *      sections whose section-text hash changed.
 *   5. Populator never throws when the manifest is missing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  populateGenomeEmbeddings,
  _clearInflightForTests,
} from "../servers/_genome-embed-populator";
import { openContextDb, type ContextDb } from "../servers/_embedding-cache";
import { embed } from "../servers/_embedding-model";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const P_HASH = "test-pop";

async function makeGenome(root: string, sections: Array<{
  path: string;
  title: string;
  summary: string;
  tags: string[];
  body: string;
}>): Promise<void> {
  const genomeDir = join(root, ".ashlrcode", "genome");
  await mkdir(genomeDir, { recursive: true });

  const manifestSections = sections.map((s) => ({
    path: s.path,
    title: s.title,
    summary: s.summary,
    tags: s.tags,
    tokens: Math.ceil(s.body.length / 4),
    updatedAt: new Date().toISOString(),
  }));

  const manifest = {
    version: 1,
    project: "test",
    sections: manifestSections,
    generation: { number: 1, milestone: "", startedAt: new Date().toISOString() },
    fitnessHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await writeFile(
    join(genomeDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  for (const s of sections) {
    const full = join(genomeDir, s.path);
    await mkdir(join(genomeDir, s.path, "..").replace(/\/[^/]+$/, (m) => m), { recursive: true }).catch(() => {});
    const dir = full.substring(0, full.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(full, s.body, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpHome: string;
let tmpRoot: string;
let ctxDb: ContextDb;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "ashlr-pop-home-"));
  tmpRoot = await mkdtemp(join(tmpdir(), "ashlr-pop-root-"));
  ctxDb = openContextDb(tmpHome);
  _clearInflightForTests();
});

afterEach(async () => {
  ctxDb.close();
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("populateGenomeEmbeddings — first-run population", () => {
  test("upserts one embedding per section and reports counts", async () => {
    await makeGenome(tmpRoot, [
      {
        path: "vision/north-star.md",
        title: "North Star Vision",
        summary: "Ultimate end-state for the project",
        tags: ["vision", "north-star"],
        body: "# North Star\n\nBuild a token-efficient plugin for Claude Code.",
      },
      {
        path: "knowledge/architecture.md",
        title: "Architecture",
        summary: "High-level system architecture for the plugin",
        tags: ["architecture", "design"],
        body: "# Architecture\n\nMCP servers route through a single process.",
      },
      {
        path: "knowledge/decisions.md",
        title: "Decisions",
        summary: "Key architectural decisions log",
        tags: ["decisions", "adr"],
        body: "# Decisions\n\nUse BM25 pseudo-embeddings before dense models.",
      },
    ]);

    const stats = await populateGenomeEmbeddings(tmpRoot, {
      ctxDb,
      home: tmpHome,
      projectHash: P_HASH,
    });

    expect(stats.unchanged).toBe(false);
    expect(stats.embedded).toBe(3);
    expect(stats.skipped).toBe(0);

    const dbStats = ctxDb.stats();
    expect(dbStats.totalEmbeddings).toBe(3);
  });

  test("populated rows are searchable via cosine similarity", async () => {
    await makeGenome(tmpRoot, [
      {
        path: "vision/north-star.md",
        title: "North Star Vision",
        summary: "Token-efficient Claude Code plugin",
        tags: ["vision"],
        body: "North star: token-efficient plugin",
      },
      {
        path: "knowledge/architecture.md",
        title: "Architecture",
        summary: "MCP server routing",
        tags: ["architecture"],
        body: "MCP servers use stdio transport and handler registration.",
      },
    ]);

    await populateGenomeEmbeddings(tmpRoot, {
      ctxDb,
      home: tmpHome,
      projectHash: P_HASH,
    });

    const queryVec = await embed("architecture MCP server routing");
    const results = ctxDb.searchSimilar({
      projectHash: P_HASH,
      embedding: queryVec,
      limit: 3,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.sectionPath).toBe("genome:knowledge/architecture.md");
    expect(results[0]!.source).toBe("genome");
  });
});

describe("populateGenomeEmbeddings — watermark behaviour", () => {
  test("no-op on second call when manifest mtime unchanged", async () => {
    await makeGenome(tmpRoot, [
      {
        path: "vision/north-star.md",
        title: "V",
        summary: "S",
        tags: [],
        body: "body",
      },
    ]);

    const first = await populateGenomeEmbeddings(tmpRoot, {
      ctxDb,
      home: tmpHome,
      projectHash: P_HASH,
    });
    expect(first.embedded).toBe(1);
    expect(first.unchanged).toBe(false);

    const second = await populateGenomeEmbeddings(tmpRoot, {
      ctxDb,
      home: tmpHome,
      projectHash: P_HASH,
    });
    expect(second.embedded).toBe(0);
    expect(second.unchanged).toBe(true);
  });

  test("bumping manifest mtime re-runs, skipping unchanged sections", async () => {
    await makeGenome(tmpRoot, [
      { path: "a.md", title: "A", summary: "a", tags: [], body: "first" },
      { path: "b.md", title: "B", summary: "b", tags: [], body: "second" },
    ]);

    await populateGenomeEmbeddings(tmpRoot, {
      ctxDb,
      home: tmpHome,
      projectHash: P_HASH,
    });

    // Rewrite only section "a"; bump manifest mtime by re-writing the manifest
    // as-is so the per-section hash map invalidates for "a" but not "b".
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(tmpRoot, ".ashlrcode", "genome", "a.md"), "CHANGED", "utf-8");
    // Re-read + re-write the manifest to bump mtime (content unchanged).
    const manifestPath = join(tmpRoot, ".ashlrcode", "genome", "manifest.json");
    const { readFile } = await import("fs/promises");
    const manifestRaw = await readFile(manifestPath, "utf-8");
    await writeFile(manifestPath, manifestRaw, "utf-8");

    _clearInflightForTests();
    const second = await populateGenomeEmbeddings(tmpRoot, {
      ctxDb,
      home: tmpHome,
      projectHash: P_HASH,
    });
    expect(second.unchanged).toBe(false);
    expect(second.embedded).toBe(1); // only a.md
    expect(second.skipped).toBe(1);  // b.md hash unchanged
  });
});

describe("populateGenomeEmbeddings — resilience", () => {
  test("never throws when manifest is missing", async () => {
    // No genome at all in tmpRoot
    const stats = await populateGenomeEmbeddings(tmpRoot, {
      ctxDb,
      home: tmpHome,
      projectHash: P_HASH,
    });
    expect(stats.unchanged).toBe(true);
    expect(stats.embedded).toBe(0);
  });

  test("does not crash when a section file is missing", async () => {
    await makeGenome(tmpRoot, [
      { path: "a.md", title: "A", summary: "a", tags: [], body: "body" },
    ]);
    // Remove the section file out from under the manifest.
    await rm(join(tmpRoot, ".ashlrcode", "genome", "a.md"));

    const stats = await populateGenomeEmbeddings(tmpRoot, {
      ctxDb,
      home: tmpHome,
      projectHash: P_HASH,
    });
    expect(stats.unchanged).toBe(false);
    expect(stats.embedded).toBe(0);
  });

  test("writes the watermark file after a successful run", async () => {
    await makeGenome(tmpRoot, [
      { path: "a.md", title: "A", summary: "a", tags: [], body: "body" },
    ]);
    await populateGenomeEmbeddings(tmpRoot, {
      ctxDb,
      home: tmpHome,
      projectHash: P_HASH,
    });
    expect(existsSync(join(tmpHome, ".ashlr", "embed-watermark.json"))).toBe(true);
  });
});
