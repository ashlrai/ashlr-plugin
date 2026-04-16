/**
 * End-to-end integration tests for cross-project genome linking.
 *
 * Pairs scripts/genome-init.ts (writes a genome) with scripts/genome-link.ts
 * (walks up to find one) to prove that a child project can borrow a
 * workspace-level genome living in an ancestor directory.
 *
 * Why temp dirs live under $HOME: findParentGenome stops the walk when it
 * would cross into or above `os.homedir()`. Bun caches the homedir() result
 * on first call, so we can't fake it via env mutation — tests must operate
 * on a real subtree of the user's HOME.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { runInit } from "../../scripts/genome-init";
import { findParentGenome } from "../../scripts/genome-link";

/** Root for the workspace under test. Lives under $HOME so findParentGenome's
 *  HOME-boundary guard doesn't short-circuit the walk. */
let workspaceDir: string;

beforeEach(() => {
  // mkdtempSync under $HOME to stay inside the HOME subtree.
  workspaceDir = mkdtempSync(join(homedir(), ".ashlr-xp-test-"));
});

afterEach(() => {
  if (workspaceDir && existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("cross-project genome — parent workspace setup", () => {
  test("parent workspace gets a genome, child does not", async () => {
    const childDir = join(workspaceDir, "child-project");
    mkdirSync(childDir, { recursive: true });

    await runInit({ dir: workspaceDir, force: false, minimal: true, summarize: false });

    expect(existsSync(join(workspaceDir, ".ashlrcode", "genome", "manifest.json"))).toBe(true);
    expect(existsSync(join(childDir, ".ashlrcode", "genome", "manifest.json"))).toBe(false);
  });
});

describe("findParentGenome — walks up to workspace genome", () => {
  test("child 1 level below workspace finds the parent genome", async () => {
    const childDir = join(workspaceDir, "child-project");
    mkdirSync(childDir, { recursive: true });
    await runInit({ dir: workspaceDir, force: false, minimal: true, summarize: false });

    const found = findParentGenome(childDir);
    expect(found).toBe(workspaceDir);
  });

  test("child 2 levels below workspace finds the parent genome with maxDepth >= 2", async () => {
    const grandchild = join(workspaceDir, "level-1", "level-2");
    mkdirSync(grandchild, { recursive: true });
    await runInit({ dir: workspaceDir, force: false, minimal: true, summarize: false });

    // Default depth (4) should find it easily.
    expect(findParentGenome(grandchild)).toBe(workspaceDir);
    // Explicit depth 2 should also find it (exactly 2 dirname() hops).
    expect(findParentGenome(grandchild, 2)).toBe(workspaceDir);
  });

  test("maxDepth=1 returns null when genome is 2 levels up", async () => {
    const grandchild = join(workspaceDir, "level-1", "level-2");
    mkdirSync(grandchild, { recursive: true });
    await runInit({ dir: workspaceDir, force: false, minimal: true, summarize: false });

    // Only look at the immediate parent — should not find the workspace genome.
    expect(findParentGenome(grandchild, 1)).toBeNull();
  });

  test("returns null when no genome exists anywhere on the walk", () => {
    const childDir = join(workspaceDir, "lonely-project");
    mkdirSync(childDir, { recursive: true });
    // No runInit called — nothing in any ancestor has a genome.
    expect(findParentGenome(childDir)).toBeNull();
  });

  test("does not cross the $HOME boundary", async () => {
    // Deliberately no genome in workspaceDir. findParentGenome from a child
    // should stop at $HOME and never reach any real genome living above it
    // (like the ones on the developer machine at ~/Desktop/<project>).
    const childDir = join(workspaceDir, "no-parent-genome");
    mkdirSync(childDir, { recursive: true });

    const found = findParentGenome(childDir, 10);
    // No genome in workspaceDir or any intervening dir up to $HOME.
    expect(found).toBeNull();
  });

  test("does not find a genome living exactly at $HOME or above", async () => {
    // Even with a huge maxDepth, findParentGenome must stop *before* $HOME.
    // We verify by creating a child many levels deep and confirming that
    // when no genome exists between it and $HOME, we get null (not whatever
    // happens to live at $HOME or above).
    const deepChild = join(workspaceDir, "a", "b", "c", "d");
    mkdirSync(deepChild, { recursive: true });
    expect(findParentGenome(deepChild, 20)).toBeNull();
  });

  test("prefers the closest ancestor genome", async () => {
    // workspace has a genome AND a mid-level dir has a genome.
    // findParentGenome should return the mid-level (closest) one.
    const midDir = join(workspaceDir, "mid");
    const leafDir = join(midDir, "leaf");
    mkdirSync(leafDir, { recursive: true });

    await runInit({ dir: workspaceDir, force: false, minimal: true, summarize: false });
    await runInit({ dir: midDir, force: false, minimal: true, summarize: false });

    // Closest ancestor wins.
    expect(findParentGenome(leafDir)).toBe(midDir);
  });
});
