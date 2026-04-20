/**
 * genome-auto-consolidate.test.ts — v1.13 novelty gate.
 *
 * Locks in the behavior that `applyFallback` now drops proposals whose
 * token-overlap against existing section lines (or prior accepted bullets
 * in the same batch) exceeds the Jaccard-similarity threshold. Addresses
 * the "junk-drawer discoveries.md" finding from the 2026-04-20 audit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { applyFallback, runConsolidate } from "../scripts/genome-auto-consolidate";

interface Proposal {
  id: string;
  agentId: string;
  section: string;
  operation: "append" | "update" | "create";
  content: string;
  rationale: string;
  timestamp: string;
  generation: number;
}

let tmpProj: string;
let genomeDir: string;

beforeEach(async () => {
  tmpProj = await mkdtemp(join(tmpdir(), "ashlr-consolidate-"));
  genomeDir = join(tmpProj, ".ashlrcode", "genome");
  await mkdir(genomeDir, { recursive: true });
  await writeFile(join(genomeDir, "manifest.json"), JSON.stringify({ generation: { number: 1 }, sections: [] }));
  delete process.env.ASHLR_GENOME_AUTO;
});

afterEach(async () => {
  await rm(tmpProj, { recursive: true, force: true }).catch(() => {});
});

function p(content: string, section = "knowledge/discoveries.md"): Proposal {
  return {
    id: Math.random().toString(36).slice(2),
    agentId: "claude-code",
    section,
    operation: "append",
    content,
    rationale: "test",
    timestamp: new Date().toISOString(),
    generation: 1,
  };
}

describe("applyFallback · novelty gate", () => {
  test("writes all bullets when the section is empty", async () => {
    const applied = applyFallback(genomeDir, [
      p("router migration collapsed 17 plugin entries into 1"),
      p("tree-sitter shadowing guard refuses renames at multiple declaration sites"),
      p("embedding cache threshold lowered to 0.68 with calibration log"),
    ]);
    expect(applied).toBe(3);
    const written = await readFile(
      join(genomeDir, "knowledge", "discoveries.md"),
      "utf-8",
    );
    expect(written).toContain("router migration");
    expect(written).toContain("tree-sitter shadowing");
    expect(written).toContain("embedding cache threshold");
  });

  test("drops bullets that duplicate an existing section line", async () => {
    // Seed the section file with one line.
    const target = join(genomeDir, "knowledge", "discoveries.md");
    await mkdir(join(genomeDir, "knowledge"), { recursive: true });
    await writeFile(
      target,
      "# discoveries\n\n- router migration collapsed 17 plugin entries into 1\n",
    );

    const applied = applyFallback(genomeDir, [
      // Near-duplicate of the seeded line.
      p("router migration collapsed 17 plugin entries into one single router"),
      // Fresh content.
      p("tree-sitter shadowing guard refuses renames at multiple declaration sites"),
    ]);
    expect(applied).toBe(1);
    const written = await readFile(target, "utf-8");
    // The duplicate line was dropped — only one "router migration" line remains.
    const matches = written.match(/router migration collapsed/g) ?? [];
    expect(matches.length).toBe(1);
    expect(written).toContain("tree-sitter shadowing");
  });

  test("dedups within a single batch — two near-identical proposals become one", async () => {
    const applied = applyFallback(genomeDir, [
      p("embedding cache threshold lowered to 0.68 with calibration logging"),
      p("embedding cache threshold lowered to 0.68 and added calibration logging"),
      p("tree-sitter shadowing guard added for rename safety"),
    ]);
    expect(applied).toBe(2);
    const written = await readFile(
      join(genomeDir, "knowledge", "discoveries.md"),
      "utf-8",
    );
    const thresholdMatches = written.match(/embedding cache threshold lowered/g) ?? [];
    expect(thresholdMatches.length).toBe(1);
    expect(written).toContain("tree-sitter shadowing");
  });

  test("does not touch the target file when every bullet is a duplicate", async () => {
    const target = join(genomeDir, "knowledge", "discoveries.md");
    await mkdir(join(genomeDir, "knowledge"), { recursive: true });
    const seededContent = "# discoveries\n\n- router migration collapsed 17 plugin entries into 1\n";
    await writeFile(target, seededContent);

    const applied = applyFallback(genomeDir, [
      p("router migration collapsed 17 plugin entries into 1"),
      p("router migration collapsed 17 plugin entries into one"),
    ]);
    expect(applied).toBe(0);
    const after = await readFile(target, "utf-8");
    // File content byte-identical — no spurious "Auto-observations" header appended.
    expect(after).toBe(seededContent);
  });

  test("short or low-token content falls through the gate (rarely duplicates)", async () => {
    const target = join(genomeDir, "knowledge", "discoveries.md");
    await mkdir(join(genomeDir, "knowledge"), { recursive: true });
    await writeFile(target, "# discoveries\n\n- foo\n");

    const applied = applyFallback(genomeDir, [
      // Empty-ish content — no meaningful tokens to compare.
      p("bar"),
      // Distinct, mid-length content.
      p("cross-platform smoke test now covers the Windows PowerShell path branch"),
    ]);
    expect(applied).toBe(2);
  });
});

describe("runConsolidate · end-to-end", () => {
  test("applies novel proposals and truncates the queue", async () => {
    const proposalsPath = join(genomeDir, "proposals.jsonl");
    const queue = [
      p("router migration collapsed 17 plugin entries into 1"),
      p("tree-sitter shadowing guard added"),
      p("embedding cache threshold lowered to 0.68"),
    ];
    await writeFile(proposalsPath, queue.map((q) => JSON.stringify(q)).join("\n") + "\n");

    const result = runConsolidate(tmpProj);
    expect(result.ran).toBe(true);
    expect(result.applied).toBe(3);
    expect(result.after).toBe(0);

    const queueAfter = await readFile(proposalsPath, "utf-8");
    expect(queueAfter).toBe("");
  });

  test("returns below-threshold when < 3 proposals", async () => {
    const proposalsPath = join(genomeDir, "proposals.jsonl");
    await writeFile(proposalsPath, JSON.stringify(p("only one")) + "\n");
    const result = runConsolidate(tmpProj);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("below-threshold");
  });
});
