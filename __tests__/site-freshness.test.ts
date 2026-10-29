import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT, buildProduct, consumerErrors, generatedFiles, prose, refreshDoc, section, syncSite } from "../site/scripts/freshness";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ashlr-site-freshness-"));
  temporary.push(root);
  for (const path of ["package.json", "CHANGELOG.md", "README.md", "ports/README.md", "scripts/cli.ts", "servers/_tool-catalog.json", "commands", "skills", "site/content/docs"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(ROOT, path), join(root, path), { recursive: true });
  }
  for (const dir of ["site/app", "site/components", "site/lib"]) mkdirSync(join(root, dir), { recursive: true });
  syncSite(false, root);
  return root;
}
function change(root: string, path: string, before: string, after: string): void {
  const full = join(root, path);
  const source = readFileSync(full, "utf8");
  expect(source).toContain(before);
  writeFileSync(full, source.replace(before, after));
}

describe("site freshness", () => {
  test("committed facts, generated reference and authored examples match source", () => {
    expect(() => syncSite(true)).not.toThrow();
    const product = buildProduct();
    expect(product.version).toBe(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
    expect(product.tools.filter((tool) => !tool.enableEnv)).toHaveLength(product.counts.mcpTools);
    expect(product.commands).toHaveLength(product.counts.slashCommands);
    expect(product.release.version).not.toBe("Unreleased");
    const help = readFileSync(join(ROOT, "site/content/docs/skills/help.mdx"), "utf8");
    for (const command of product.commands) expect(help).toContain(`/${command.name}`);
    for (const retired of ["demo", "badge", "recall", "usage", "context-status", "errors"]) expect(help).not.toContain(`/ashlr-${retired}`);
  });

  test("section extraction ignores heading-shaped comments inside fenced commands", () => {
    expect(section("## Install\n```sh\n# comment\nrun\n```\n## Other\nend", "Install")).toContain("run\n```");
    expect(() => section("", "Install")).toThrow("Missing source section");
  });

  test("package version drift fails without rewriting files in check mode", () => {
    const root = fixture();
    const productPath = join(root, "site/lib/product.generated.json");
    const previous = readFileSync(productPath, "utf8");
    const statusPath = join(root, "site/content/docs/concepts/status-line.mdx");
    const statusBefore = readFileSync(statusPath, "utf8");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pkg.version = "99.0.0";
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    expect(() => syncSite(true, root)).toThrow("is stale");
    expect(readFileSync(productPath, "utf8")).toBe(previous);
    syncSite(false, root);
    expect(() => syncSite(true, root)).not.toThrow();
    expect(readFileSync(join(root, "site/content/docs/release.mdx"), "utf8")).toContain("Current package version: **99.0.0**");
    expect(readFileSync(statusPath, "utf8")).toBe(statusBefore);
  });

  test("changed source install command invalidates every generated copy", () => {
    const root = fixture();
    change(root, "README.md", "codex plugin add ashlr@ashlr-marketplace", "codex plugin add changed@marketplace");
    expect(() => syncSite(true, root)).toThrow("is stale");
    syncSite(false, root);
    for (const path of ["site/content/docs/index.mdx", "site/content/docs/getting-started/install.mdx", "site/lib/product.generated.json", "site/lib/docs.generated.json"]) {
      expect(readFileSync(join(root, path), "utf8")).toContain("codex plugin add changed@marketplace");
    }
  });

  test("new release skips Unreleased and refreshes the release page", () => {
    const root = fixture();
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    writeFileSync(join(root, "CHANGELOG.md"), changelog.replace(/(?=^## \[\d)/m, "## [99.0.0] - 2026-12-01\n\n### Added\n\n- Released feature\n\n"));
    expect(buildProduct(root).release).toEqual({ version: "99.0.0", date: "2026-12-01", notes: "### Added\n\n- Released feature" });
    expect(() => syncSite(true, root)).toThrow("is stale");
  });

  test("catalog and command changes invalidate the site, optional tools retain their gate", () => {
    const root = fixture();
    const catalog = JSON.parse(readFileSync(join(root, "servers/_tool-catalog.json"), "utf8"));
    catalog.push({ name: "ashlr__freshness_fixture", description: "New capability", inputSchema: { type: "object", properties: {} } });
    writeFileSync(join(root, "servers/_tool-catalog.json"), JSON.stringify(catalog));
    writeFileSync(join(root, "commands/ashlr-freshness-fixture.md"), "---\nname: ashlr-freshness-fixture\ndescription: New workflow\n---\n");
    expect(() => syncSite(true, root)).toThrow("is stale");
    const product = buildProduct(root);
    expect(product.tools.find((tool) => tool.name === "ashlr__pipe")?.enableEnv).toBe("ASHLR_PIPE_ENABLE");
    syncSite(false, root);
    expect(() => syncSite(true, root)).not.toThrow();
    expect(readFileSync(join(root, "site/content/docs/skills/index.mdx"), "utf8")).toContain("/ashlr-freshness-fixture");
    expect(readFileSync(join(root, "site/content/docs/tools/capabilities.mdx"), "utf8")).toContain("ashlr__freshness_fixture");
  });

  test("workflow skill source drift updates the reference, navigation and missing guide", () => {
    const root = fixture();
    const sourcePath = "skills/ashlr-search/SKILL.md";
    change(root, sourcePath, "Genome-aware search habits for Claude Code.", "Updated workflow description.");
    expect(() => syncSite(true, root)).toThrow("is stale");
    const name = "ashlr-freshness-skill";
    mkdirSync(join(root, "skills", name));
    writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: New source-backed workflow.\n---\n`);
    syncSite(false, root);
    expect(() => syncSite(true, root)).not.toThrow();
    const product = buildProduct(root);
    expect(product.workflowSkills.find((skill) => skill.name === "ashlr-search")?.description)
      .toContain("Updated workflow description.");
    const index = readFileSync(join(root, "site/content/docs/skills/index.mdx"), "utf8");
    expect(index).toContain("Updated workflow description.");
    expect(index).toContain(name);
    const navigation = JSON.parse(readFileSync(join(root, "site/content/docs/skills/meta.json"), "utf8")) as { pages: string[] };
    expect(navigation.pages).toContain("freshness-skill");
    expect(new Set(navigation.pages).size).toBe(navigation.pages.length);
    expect(navigation.pages.filter((slug) => slug === "brief")).toHaveLength(1);
    expect(readFileSync(join(root, "site/content/docs/skills/freshness-skill.mdx"), "utf8"))
      .toContain("New source-backed workflow.");
    for (const orphan of ["badge", "context-status", "demo", "errors", "recall", "usage"]) {
      expect(navigation.pages).not.toContain(orphan);
      expect(existsSync(join(root, `site/content/docs/skills/${orphan}.mdx`))).toBe(false);
    }
  });

  test.each([
    "v0.0.1 is current", 'softwareVersion: "latest"',
    "40 MCP tools", "35 slash commands", "The 40-tool router",
    "curl -fsSL https://plugin.ashlr.ai/install.sh | bash",
    "codex plugin marketplace add ashlrai/ashlr-plugin",
    "npm install -g ashlr-plugin", "git clone https://github.com/ashlrai/ashlr-plugin",
    "Current version: 0.0.1", "<code>ashlr-plugin removed-command</code>",
    "<span>v0.0.1</span>", "<span>0.0.1</span>", '<code>/plugin install obsolete</code>',
  ])("copied page fact is rejected: %s", (source) => {
    expect(consumerErrors("site/app/page.tsx", source).length).toBeGreaterThan(0);
  });

  test("copied page versions and commands make the gate fail", () => {
    const root = fixture();
    writeFileSync(join(root, "site/app/page.tsx"), 'export default () => <p>v0.0.1 is current</p>');
    expect(() => syncSite(true, root)).toThrow("copied product fact");
  });

  test("malformed or missing sources fail closed", () => {
    const root = fixture();
    writeFileSync(join(root, "servers/_tool-catalog.json"), "[]");
    expect(() => buildProduct(root)).toThrow("Empty or duplicate");
    writeFileSync(join(root, "CHANGELOG.md"), "## [Unreleased]\nPending only");
    expect(() => buildProduct(root)).toThrow("no dated release");
  });

  test("generated corpus includes complete content and generation is idempotent", () => {
    const root = fixture();
    const before = [...generatedFiles(root)];
    syncSite(false, root);
    expect([...generatedFiles(root)]).toEqual(before);
    const docs = JSON.parse(readFileSync(join(root, "site/lib/docs.generated.json"), "utf8")) as Array<{ url: string; content: string }>;
    expect(new Set(docs.map((doc) => doc.url)).size).toBe(docs.length);
    expect(docs.find((doc) => doc.url === "/docs/tools")?.content).toContain("ashlr__read");
    expect(docs.find((doc) => doc.url === "/docs/getting-started/install")?.content).toContain(buildProduct(root).install.codex);
  });

  test("generated docs keep heading levels consecutive under the page title", () => {
    for (const [path, source] of generatedFiles(ROOT)) {
      if (!path.endsWith(".mdx")) continue;
      const body = source.replace(/^---\n[\s\S]*?\n---\n*/, "");
      let fenced = false;
      const levels = [1];
      for (const line of body.split("\n")) {
        if (/^\s*```/.test(line)) fenced = !fenced;
        else if (!fenced) {
          const match = /^(#{1,6}) /.exec(line);
          if (match) levels.push(match[1].length);
        }
      }
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] > levels[i - 1] + 1) throw new Error(`${path}: heading jump ${levels.join(" -> ")}`);
      }
    }
  });

  test("authored sample versions and counts refresh with source", () => {
    const product = buildProduct();
    expect(refreshDoc("ashlr v0.0.1 [2 tools]\nVersion: 0.0.1\n2 MCP tools, 1 slash commands", product))
      .toBe(`ashlr v${product.version} [${product.counts.mcpTools} tools]\nVersion: ${product.version}\n${product.counts.mcpTools} MCP tools, ${product.counts.slashCommands} slash commands`);
  });

  test("registry prose cannot become MDX expressions or JSX, and inline code stays readable", () => {
    expect(prose('Use {key: value} or <path> and `{"key": "value"}`'))
      .toBe('Use &#123;key: value&#125; or &lt;path&gt; and `{"key": "value"}`');
  });
});
