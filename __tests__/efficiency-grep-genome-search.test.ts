/**
 * Track 5 follow-up (v1.27.1): verifies ashlrGrep consults the
 * _genome-search inverted index before falling through to ripgrep.
 *
 * Builds a fixture repo with a populated .ashlrcode/genome/knowledge/ dir,
 * calls ashlrGrep with a pattern that has ≥3 token hits in the index, and
 * asserts the response carries the genome-search-index attribution
 * (skipping ripgrep entirely).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ashlrGrep } from "../servers/efficiency-server";

let repoRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  repoRoot = mkdtempSync(join(tmpdir(), "grep-genome-search-"));
  // Move into the repo so clampToCwd accepts the cwd argument.
  process.chdir(repoRoot);

  const knowledgeDir = join(repoRoot, ".ashlrcode", "genome", "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });

  // Multi-section corpus with three distinct sections that all match the
  // token "router" — exceeds the index-hit threshold of >=3.
  writeFileSync(
    join(knowledgeDir, "architecture.md"),
    [
      "# Architecture",
      "",
      "## Router design",
      "",
      "The router dispatches MCP tool calls to per-tool handlers.",
      "",
      "## Router migration",
      "",
      "All v1.13 servers now route through `_router-handlers.ts`.",
      "",
      "## Router cold-start",
      "",
      "First call after warm starts averages 38ms in v1.24+.",
      "",
    ].join("\n"),
    "utf8",
  );

  // Manifest scaffold so genomeExists() returns true.
  writeFileSync(
    join(repoRoot, ".ashlrcode", "genome", "manifest.json"),
    JSON.stringify({ generation: 1, sections: [] }),
    "utf8",
  );
});

afterEach(() => {
  process.chdir(originalCwd);
  try {
    rmSync(repoRoot, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

describe("ashlrGrep × _genome-search index", () => {
  test("returns genome-search-index source when ≥3 hits found", async () => {
    const result = await ashlrGrep({ pattern: "router", cwd: repoRoot });
    // The new code path emits this attribution string.
    expect(result).toContain("source=genome-search-index");
    expect(result).toContain("ripgrep skipped");
    // And cites at least one section.
    expect(result).toMatch(/from genome:/);
  });

  test("falls through to ripgrep when pattern has zero genome hits", async () => {
    const result = await ashlrGrep({ pattern: "xyzzy_no_such_token_42", cwd: repoRoot });
    // No genome attribution because the index returned 0 hits.
    expect(result).not.toContain("source=genome-search-index");
  });
});
