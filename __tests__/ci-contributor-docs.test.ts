import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSERTION_SUMMARY_LINES, FAILURE_LOG } from "../scripts/unit-test-failure-report";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const workflow = read(".github/workflows/ci.yml");
const testing = read("site/content/docs/contributing/testing.mdx");

function job(id: string): string {
  const body = workflow.match(new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "m"))?.[1];
  if (!body) throw new Error(`Missing CI job: ${id}`);
  return body;
}

describe("contributor docs describe current CI diagnostics", () => {
  test("the documented setup install includes every flag used by setup.mjs", () => {
    const args = read("scripts/setup.mjs").match(/run\((\["install"[^\n]+\])\);/)?.[1];
    expect(args).toBeDefined();
    const command = `bun ${(JSON.parse(args!) as string[]).join(" ")}`;
    expect(read("CONTRIBUTING.md")).toContain(`\`${command}\``);
  });

  test("platform gates are documented outside the required CI Gate dependencies", () => {
    const needs = job("gate").match(/^    needs: \[([^\]]+)\]/m)?.[1].split(/,\s*/);
    expect(needs).toBeDefined();
    for (const id of ["os-fast-windows", "os-fast-macos", "install-smoke-linux", "install-smoke-windows", "install-smoke-macos"]) {
      expect(needs).not.toContain(id);
      expect(job(id)).toContain("github.event_name == 'pull_request'");
    }
    for (const path of ["CONTRIBUTING.md", "site/content/docs/contributing/index.mdx", "site/content/docs/contributing/testing.mdx"]) {
      const text = read(path);
      expect(text, path).toContain("Linux install smoke");
      expect(text, path).toContain("outside `CI Gate`");
      expect(text, path).toContain("`scripts/os-path-gate.mjs`");
      for (const os of ["linux", "windows", "macos"]) {
        const name = job(`gate-${os}`).match(/^    name: (.+)$/m)?.[1];
        expect(name).toBeDefined();
        expect(text, path).toContain(`\`${name}\``);
      }
    }
    expect(testing).not.toContain("run two jobs");
  });

  test("diagnostics docs include the install smokes selected by every dispatch", () => {
    for (const os of ["linux", "windows", "macos"]) {
      const smoke = job(`install-smoke-${os}`);
      expect(smoke).toContain("github.event_name == 'workflow_dispatch'");
      expect(smoke).not.toContain("inputs.validation_scope");
      expect(smoke).toContain("bun scripts/install-smoke.ts commit");
      expect(smoke).toContain("bun scripts/install-smoke.ts release");
    }
    for (const path of ["site/content/docs/contributing/testing.mdx", "docs/platform-support.md", "docs/architecture.md"]) {
      const text = read(path);
      expect(text, path).toMatch(/install smokes also run on every dispatch/i);
      expect(text, path).toContain("release qualification");
      expect(text, path).not.toMatch(/windows-diagnostics[^\n]*runs only/);
    }
  });

  test("failure artifact instructions match the CI runner and reporter", () => {
    expect(read("scripts/run-root-tests.ts")).toContain('if (onCi) args.push("--bail=1")');
    expect(testing).toContain("`--bail=1`");
    expect(testing).toContain(`up to ${ASSERTION_SUMMARY_LINES} assertion lines`);
    expect(testing).toContain(`\`${FAILURE_LOG.replaceAll("\\", "/")}\``);
    expect(testing).toContain("`unit-test-failure-<OS>`");
    expect(testing).toContain("Local runs omit `--bail=1`");
    for (const id of ["linux", "other-os", "os-fast-windows", "os-fast-macos"]) {
      const body = job(id);
      expect(body).toContain("name: unit-test-failure-${{ runner.os }}");
      expect(body).toContain(`path: ${FAILURE_LOG.replaceAll("\\", "/")}`);
    }
  });
});
