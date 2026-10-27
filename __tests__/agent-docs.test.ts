import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentDocuments, markdownHeadings, renderAgentIndex, renderAgentCorpus } from "../site/lib/agent-docs";

describe("agent documentation generation", () => {
  test("ignores fenced examples, including nested shorter fences", () => {
    expect(markdownHeadings("# Title\n````md\n# Example\n```\n# Still code\n````\n## Install\n~~~sh\n# Comment\n~~~\n### Verify ###")).toEqual(["Title", "Install", "Verify"]);
  });

  test("source edits flow into both representations without a manual index", () => {
    const documents = [{ title: "README", url: "https://example.test/README.md", body: "# Plugin\n\n> **Source summary**\n\n## New capability\n\nActual instructions." }];
    const index = renderAgentIndex(documents);
    expect(index).toContain("> Source summary");
    expect(index).toContain("[README](https://example.test/README.md): Plugin; New capability");
    expect(renderAgentCorpus(documents)).toContain(documents[0].body);
    expect(renderAgentCorpus(documents)).toContain("Source: https://example.test/README.md");
  });
});


test("reads complete source and fails on missing documents instead of silently truncating", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-docs-"));
  const site = join(root, "site");
  try {
    mkdirSync(join(site, "content/docs"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# Source README\n## Install\n");
    writeFileSync(join(site, "content/docs/install.mdx"), "---\ntitle: Install\n---\n\n## Verify\nRun the doctor.\n");
    const pages = [{ url: "/docs/install", file: { path: "install.mdx" }, data: { title: "Install" } }];
    const documents = readAgentDocuments(pages, site);
    expect(documents[0].body).toContain("# Source README");
    expect(documents[1]).toEqual({ title: "Install", url: "https://plugin.ashlr.ai/docs/install", body: "\n## Verify\nRun the doctor.\n" });
    rmSync(join(site, "content/docs/install.mdx"));
    expect(() => readAgentDocuments(pages, site)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
