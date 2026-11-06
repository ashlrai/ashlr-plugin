import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");

describe("genome build temporary directories", () => {
  test("genome-build creates mkdtemp work dirs inside try and removes them in finally", () => {
    const src = readFileSync(join(REPO, "server/src/services/genome-build.ts"), "utf8");
    expect(src).toContain('workDir = await mkdtemp(join(tmpdir(), "ashlr-build-"))');
    expect(src).toContain('workDir = await mkdtemp(join(tmpdir(), "ashlr-delta-"))');
    // Both the initial build and the delta rebuild must clean the work root,
    // not just the clone dir (the askpass helper lives beside the clone).
    expect(src.match(/rm\(workDir/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // The askpass staging root is created owner-only when it has to be made.
    expect(src).toContain("mkdir(workRoot, { recursive: true, mode: 0o700 })");

    // Structural check per function: `let workDir` is declared before the try,
    // mkdtemp is the first statement inside the try, and rm(workDir) happens
    // in the finally — so a throw between declaration and assignment can't
    // leak a directory and a throw after assignment can't skip cleanup.
    for (const [sig, endSig] of [
      ["async function runBuildInBackground", "export async function rebuildGenomeDelta"],
      ["export async function rebuildGenomeDelta", undefined],
    ] as const) {
      const start = src.indexOf(sig);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = endSig ? src.slice(start, src.indexOf(endSig)) : src.slice(start);
      const decl = body.indexOf("let workDir");
      const mkd = body.indexOf("mkdtemp(");
      expect(decl).toBeGreaterThanOrEqual(0);
      expect(mkd).toBeGreaterThan(decl);
      const tryBefore = body.lastIndexOf("try {", mkd);
      expect(tryBefore).toBeGreaterThan(decl);
      // mkdtemp is the first statement inside the try.
      expect(body.slice(tryBefore + "try {".length, mkd).trim()).toBe("workDir = await");
      const fin = body.lastIndexOf("finally");
      const rm = body.lastIndexOf("rm(workDir");
      expect(rm).toBeGreaterThan(fin);
      expect(fin).toBeGreaterThan(mkd);
    }
  });
});
