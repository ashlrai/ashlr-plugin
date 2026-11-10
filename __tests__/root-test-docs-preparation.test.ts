import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { prepareRootTestDocs } from "../scripts/prepare-root-test-docs";
import { generatedFiles, ROOT, syncSite } from "../site/scripts/freshness";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ashlr-root-test-docs-"));
  temporary.push(root);
  for (const path of ["package.json", "CHANGELOG.md", "README.md", "ports/README.md", "scripts/lib/codex-doctor.ts", "servers/_tool-catalog.json", "commands", "skills", "site/content/docs"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(ROOT, path), join(root, path), { recursive: true });
  }
  for (const dir of ["site/app", "site/components", "site/lib"]) mkdirSync(join(root, dir), { recursive: true });
  syncSite(false, root);
  return root;
}

test("root runner prepares only the excluded corpus before workers; fresh references remain read-only", () => {
  const root = fixture();
  const product = join(root, "site/lib/product.generated.json");
  const before = readFileSync(product, "utf8");
  const guide = join(root, "site/content/docs/tools/search-replace-regex.mdx");
  const updated = readFileSync(guide, "utf8") + "\nNew authored source example.\n";
  writeFileSync(guide, updated);
  expect(() => syncSite(true, root)).toThrow("docs.generated.json is stale");
  prepareRootTestDocs(root);
  const generated = generatedFiles(root).get("site/lib/docs.generated.json");
  if (generated === undefined) throw new Error("Expected generated docs corpus");
  expect(readFileSync(join(root, "site/lib/docs.generated.json"), "utf8")).toBe(generated);
  expect(readFileSync(product, "utf8")).toBe(before);
  expect(readFileSync(guide, "utf8")).toBe(updated);
  expect(() => syncSite(true, root)).not.toThrow();
});

test("preparation cannot hide authored or product-fact drift", () => {
  const root = fixture();
  const authored = join(root, "site/content/docs/release.mdx");
  const stale = readFileSync(authored, "utf8").replace("Current package version:", "Outdated package version:");
  writeFileSync(authored, stale);
  const product = join(root, "site/lib/product.generated.json");
  writeFileSync(product, "{}\n");
  prepareRootTestDocs(root);
  expect(readFileSync(authored, "utf8")).toBe(stale);
  expect(readFileSync(product, "utf8")).toBe("{}\n");
  expect(() => syncSite(true, root)).toThrow("site/content/docs/release.mdx is stale");
  expect(() => syncSite(true, root)).toThrow("site/lib/product.generated.json is stale");
});

test("generator errors fail before corpus writes or test-child admission", () => {
  const root = fixture();
  const target = join(root, "site/lib/docs.generated.json");
  const before = readFileSync(target, "utf8");
  writeFileSync(join(root, "package.json"), "invalid-json");
  expect(() => prepareRootTestDocs(root)).toThrow();
  expect(readFileSync(target, "utf8")).toBe(before);
});

test("coverage workflow prepares the corpus before its direct bun test call", () => {
  // coverage.yml bypasses scripts/run-root-tests.ts; without this step the
  // freshness tests compare source against the stale committed corpus.
  const workflow = readFileSync(join(ROOT, ".github/workflows/coverage.yml"), "utf8");
  const prepare = workflow.indexOf("bun scripts/prepare-root-test-docs.ts");
  const run = workflow.indexOf("bun test --parallel");
  expect(prepare).toBeGreaterThan(-1);
  expect(run).toBeGreaterThan(prepare);
});
