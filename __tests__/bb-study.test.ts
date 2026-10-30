import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const docPath = join(root, "docs/bb-study.md");
const doc = readFileSync(docPath, "utf8");

// A bb source path is a backticked repo-relative path under the trees the
// study read (apps/, packages/, plugins/, docs/, .bb/, scripts/).
const BB_PATH = /`((?:apps|packages|plugins|docs|scripts|\.bb)\/[^`\s]+)`/g;

const findings = doc
  .split(/^### /m)
  .slice(1)
  .map(section => section.trim());

describe("bb study document", () => {
  test("docs/bb-study.md exists", () => {
    expect(existsSync(docPath)).toBe(true);
  });

  test("has at least 6 findings", () => {
    expect(findings.length).toBeGreaterThanOrEqual(6);
  });

  test("covers every required topic", () => {
    const headings = findings.map(f => f.split("\n")[0].toLowerCase());
    for (const topic of ["thread", "plugin", "spawn", "handoff", "worktree", "remote"]) {
      expect(headings.some(h => h.includes(topic))).toBe(true);
    }
  });

  test("every finding names a bb source path", () => {
    for (const finding of findings) {
      const paths = [...finding.matchAll(BB_PATH)].map(m => m[1]);
      expect(paths.length).toBeGreaterThan(0);
    }
  });

  test("every finding states how bb does it, the fleet gap, and a shippable item with target files", () => {
    for (const finding of findings) {
      expect(finding).toContain("**bb**:");
      expect(finding).toContain("**Gap**:");
      expect(finding).toContain("**Ship it**:");
      // Target files are ashlr-repo paths named after the "Ship it" clause.
      // A target suffixed with "(new)" is proposed, not yet present.
      const ship = finding.split("**Ship it**:")[1];
      const targets = [...ship.matchAll(/`((?:servers|scripts|__tests__|docs|commands)\/[^`\s]+)`(\s*\(new\))?/g)];
      expect(targets.length).toBeGreaterThan(0);
      for (const [, target, isNew] of targets) {
        if (!isNew) expect(existsSync(join(root, target))).toBe(true);
      }
    }
  });
});
