/**
 * genome-auto-propose.test.ts — v1.13 signal-tightening.
 *
 * The auto-propose PostToolUse hook was shown in the 2026-04-20 audit to
 * produce mostly noise (367 proposals consolidated in a single day). This
 * suite locks in the v1.13 filter tightenings:
 *
 *   1. Minimum content length 400 chars (up from 200).
 *   2. Manifest-overlap gate — proposals must mention at least one
 *      vocabulary token from `.ashlrcode/genome/manifest.json` (falls open
 *      for fresh genomes with < 3 sections).
 *   3. Existing guards unchanged (whitelist, signal regex, dedup).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildManifestVocabulary,
  runPropose,
  shouldPropose,
  textOverlapsVocabulary,
} from "../scripts/genome-auto-propose";

// Long enough to satisfy the 400-char minimum.
const LONG_TEXT =
  "architecture: we introduced the edit_structural tool as the flagship v1.13 " +
  "deliverable. It uses tree-sitter to rename identifiers within a single " +
  "TypeScript file, with a conservative shadowing guard that refuses to " +
  "proceed when multiple declaration sites share the same name. The decision " +
  "traces back to avoiding silently-wrong renames that a regex-based tool " +
  "would produce on shadowed locals, and the shared handler registry pattern " +
  "from _tool-base.ts makes the new tool a natural fit. invariant preserved.";

let tmpProj: string;
let genomeDir: string;
let seenPath: string;

beforeEach(async () => {
  tmpProj = await mkdtemp(join(tmpdir(), "ashlr-genome-auto-"));
  genomeDir = join(tmpProj, ".ashlrcode", "genome");
  await mkdir(genomeDir, { recursive: true });
  seenPath = join(tmpProj, "seen.json");
  // Ensure env doesn't disable auto or the gate in this test process.
  delete process.env.ASHLR_GENOME_AUTO;
  delete process.env.ASHLR_GENOME_REQUIRE_OVERLAP;
});

afterEach(async () => {
  await rm(tmpProj, { recursive: true, force: true }).catch(() => {});
});

async function writeManifest(sections: Array<{ title: string; tags?: string[]; summary?: string }>): Promise<void> {
  await writeFile(
    join(genomeDir, "manifest.json"),
    JSON.stringify({ generation: { number: 1 }, sections }),
  );
}

// ---------------------------------------------------------------------------
// shouldPropose — content length + signal regex
// ---------------------------------------------------------------------------

describe("shouldPropose · content length", () => {
  test("rejects text shorter than 400 chars", () => {
    const d = shouldPropose({
      tool_name: "ashlr__read",
      tool_result: "architecture decision pattern — short".padEnd(300, "."),
    });
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("content-too-short");
  });

  test("accepts text ≥ 400 chars with a signal keyword", () => {
    const d = shouldPropose({
      tool_name: "ashlr__read",
      tool_result: LONG_TEXT,
    });
    expect(d.ok).toBe(true);
  });

  test("rejects long text that lacks a signal keyword", () => {
    const plainText = "lorem ipsum ".repeat(60);
    const d = shouldPropose({
      tool_name: "ashlr__read",
      tool_result: plainText,
    });
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("no-signal");
  });

  test("rejects non-whitelisted tools", () => {
    const d = shouldPropose({
      tool_name: "TodoWrite",
      tool_result: LONG_TEXT,
    });
    expect(d.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildManifestVocabulary / textOverlapsVocabulary
// ---------------------------------------------------------------------------

describe("buildManifestVocabulary", () => {
  test("extracts tokens from section titles, summaries, and tags", async () => {
    await writeManifest([
      { title: "ashlr__edit_structural rename guard", tags: ["refactor", "ast"], summary: "tree-sitter integration" },
      { title: "router migration", tags: ["infra"], summary: "handler registry" },
      { title: "genome synthesis", tags: ["llm"], summary: "consolidation quality gate" },
    ]);
    const vocab = buildManifestVocabulary(genomeDir);
    expect(vocab.has("ashlr__edit_structural")).toBe(true);
    expect(vocab.has("router")).toBe(true);
    expect(vocab.has("handler")).toBe(true);
    expect(vocab.has("genome")).toBe(true);
    expect(vocab.has("tree-sitter")).toBe(true);
    // Stopwords + short tokens dropped.
    expect(vocab.has("the")).toBe(false);
    expect(vocab.has("ast")).toBe(false); // 3 chars — below MIN_OVERLAP_TOKEN_LEN=5
  });

  test("returns empty set for fresh genomes (< 3 sections)", async () => {
    await writeManifest([{ title: "just started" }]);
    const vocab = buildManifestVocabulary(genomeDir);
    expect(vocab.size).toBe(0);
  });

  test("returns empty set when manifest is missing", () => {
    const vocab = buildManifestVocabulary(genomeDir);
    expect(vocab.size).toBe(0);
  });
});

describe("textOverlapsVocabulary", () => {
  test("true when the text contains a vocabulary token", () => {
    const vocab = new Set(["architecture", "invariant"]);
    expect(textOverlapsVocabulary("we changed the Architecture today", vocab)).toBe(true);
  });

  test("false when no tokens match", () => {
    const vocab = new Set(["kubernetes", "terraform"]);
    expect(textOverlapsVocabulary("a short note about something else", vocab)).toBe(false);
  });

  test("always-true when the vocabulary is empty (gate open)", () => {
    expect(textOverlapsVocabulary("anything", new Set())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runPropose · manifest-overlap gate end-to-end
// ---------------------------------------------------------------------------

describe("runPropose · manifest-overlap gate", () => {
  test("rejects a signal-matching proposal that doesn't overlap the manifest", async () => {
    // Established genome with a distinct vocabulary.
    await writeManifest([
      { title: "kubernetes deployment rollout" },
      { title: "terraform module refactor" },
      { title: "dns migration playbook" },
    ]);
    const outcome = runPropose(
      {
        tool_name: "ashlr__read",
        tool_result: LONG_TEXT, // talks about tree-sitter + handler — no overlap
      },
      { cwd: tmpProj, seenPath },
    );
    expect(outcome.wrote).toBe(false);
    expect(outcome.reason).toBe("no-manifest-overlap");
  });

  test("accepts a proposal that overlaps at least one manifest token", async () => {
    await writeManifest([
      { title: "handler registry architecture" },
      { title: "tree-sitter rename scope" },
      { title: "router consolidation" },
    ]);
    const outcome = runPropose(
      { tool_name: "ashlr__read", tool_result: LONG_TEXT },
      { cwd: tmpProj, seenPath },
    );
    expect(outcome.wrote).toBe(true);
    const written = await readFile(join(genomeDir, "proposals.jsonl"), "utf-8");
    expect(written).toMatch(/edit_structural|handler|tree-sitter/i);
  });

  test("fresh genome (<3 sections) falls open — no overlap required", async () => {
    await writeManifest([{ title: "just started" }, { title: "one more" }]);
    const outcome = runPropose(
      { tool_name: "ashlr__read", tool_result: LONG_TEXT },
      { cwd: tmpProj, seenPath },
    );
    expect(outcome.wrote).toBe(true);
  });

  test("ASHLR_GENOME_REQUIRE_OVERLAP=0 disables the gate", async () => {
    await writeManifest([
      { title: "kubernetes" },
      { title: "terraform" },
      { title: "dns" },
    ]);
    process.env.ASHLR_GENOME_REQUIRE_OVERLAP = "0";
    try {
      const outcome = runPropose(
        { tool_name: "ashlr__read", tool_result: LONG_TEXT },
        { cwd: tmpProj, seenPath },
      );
      expect(outcome.wrote).toBe(true);
    } finally {
      delete process.env.ASHLR_GENOME_REQUIRE_OVERLAP;
    }
  });
});
