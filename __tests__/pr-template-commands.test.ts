import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Keeps the PR template's checklist runnable and in step with CONTRIBUTING.md:
// every `bun run <script>` it names exists in package.json, every file it
// tells people to `bun` exists, and the reference-sync steps match the ones
// CONTRIBUTING.md's PR checklist gives for tool, skill and command changes.

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

const TEMPLATE = ".github/PULL_REQUEST_TEMPLATE.md";

describe("PR template", () => {
  const template = read(TEMPLATE);
  const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts;

  test("every `bun run <script>` it names is a package.json script", () => {
    const named = [...template.matchAll(/`bun run ([\w:-]+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      expect(scripts[name], `${TEMPLATE} names missing script "${name}"`).toBeDefined();
    }
  });

  test("every file it runs with bun exists", () => {
    const files = [...template.matchAll(/`bun (?:test )?((?:scripts|__tests__)\/[^\s`]+\.ts)/g)].map((m) => m[1]);
    const tests = [...template.matchAll(/(__tests__\/[\w.-]+\.test\.ts)/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(0);
    for (const file of [...files, ...tests]) {
      expect(() => read(file), `${TEMPLATE} names missing file ${file}`).not.toThrow();
    }
  });

  test("gives the fork base for the pre-merge check", () => {
    expect(template).toContain("bun scripts/premerge-local.ts origin/main");
    expect(template).toContain("`upstream/main` from a fork");
  });

  test("tool, skill and command changes use the same sync steps as CONTRIBUTING.md", () => {
    const contributing = read("CONTRIBUTING.md");
    for (const step of ["bun run references:sync", "bun run references:check", "bun run doctor:sync"]) {
      expect(contributing, `CONTRIBUTING.md should name ${step}`).toContain(step);
      expect(template, `${TEMPLATE} should name ${step}`).toContain(step);
    }
    // tool-counts:check only checks tool counts; it is not the check for skill or command changes.
    expect(template).not.toMatch(/commands,? or skills changed[^\n]*tool-counts:check/);
    expect(read("scripts/sync-install-manifest.ts")).toContain("install-manifest.json");
  });
});
