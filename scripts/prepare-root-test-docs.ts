import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generatedFiles, ROOT } from "../site/scripts/freshness.ts";

/** The corpus is a build artifact excluded by AGENTS.md, unlike authored facts.
 * Prepare only that fixed artifact before parallel test workers can read it.
 * Keep product facts and authored references untouched so freshness detects drift.
 */
export function prepareRootTestDocs(root = ROOT): void {
  const relativePath = "site/lib/docs.generated.json";
  const corpus = generatedFiles(root).get(relativePath);
  if (typeof corpus !== "string") throw new Error("Generated docs corpus is unavailable");
  const target = join(root, relativePath);
  if (existsSync(target) && readFileSync(target, "utf8") === corpus) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, corpus);
}

// CLI entry for runners that call `bun test` directly (coverage.yml needs
// flags run-root-tests.ts does not forward) so they get the same preparation.
if (import.meta.main) prepareRootTestDocs();
