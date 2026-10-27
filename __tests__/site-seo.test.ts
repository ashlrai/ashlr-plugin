import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { useCases } from "../site/lib/use-cases";
import { canonicalUrl, gitLastModified, sitemapEntries } from "../site/lib/sitemap";

const root = resolve(import.meta.dir, "..");
function sourceFile(href: string) {
  const code = href.match(/^https:\/\/github\.com\/ashlrai\/ashlr-plugin\/blob\/[a-f0-9]{40}\/(servers\/[a-z-]+\.ts)(?:#L\d+(?:-L\d+)?)?$/);
  if (code) return existsSync(join(root, code[1])) ? join(root, code[1]) : undefined;
  const base = join(root, "site/content", href);
  return [base + ".mdx", join(base, "index.mdx")].find(existsSync);
}

describe("sourced use cases", () => {
  test("two to four distinct workflows, all claims have real repository sources", () => {
    expect(useCases.length).toBeGreaterThanOrEqual(2);
    expect(useCases.length).toBeLessThanOrEqual(4);
    expect(new Set(useCases.map((page) => page.slug)).size).toBe(useCases.length);
    for (const page of useCases) {
      expect(page.claims.length).toBeGreaterThan(0);
      expect(page.steps.length).toBeGreaterThan(0);
      expect(JSON.stringify(page)).not.toContain("\u2014");
      for (const claim of page.claims) {
        expect(claim.text.trim().length).toBeGreaterThan(0);
        expect(claim.sources.length).toBeGreaterThan(0);
        for (const source of claim.sources) {
          expect(source.label.trim()).not.toBe("");
          expect(source.href).toMatch(/^(\/docs\/[a-z0-9/-]+|https:\/\/github\.com\/ashlrai\/ashlr-plugin\/blob\/)/);
          const file = sourceFile(source.href);
          expect(file).toBeDefined();
          expect(readFileSync(file!, "utf8").length).toBeGreaterThan(100);
        }
      }
    }
  });
});

describe("sitemap", () => {
  test("normalizes trailing slashes and deduplicates canonical URLs", () => {
    expect(canonicalUrl("/")).toBe("https://plugin.ashlr.ai/");
    expect(canonicalUrl("/docs/")).toBe("https://plugin.ashlr.ai/docs");
    expect(sitemapEntries([{ path: "/docs", files: [] }, { path: "/docs/", files: [] }])).toHaveLength(1);
  });
  test("rejects off-site, fragment and query URLs", () => {
    for (const path of ["https://example.com", "//example.com", "/docs?x=1", "/#install"]) {
      expect(() => canonicalUrl(path)).toThrow();
    }
  });
  test("uses the source commit date, not build time, and omits unknown dates", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashlr-seo-git-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    try {
      expect(gitLastModified(["page.tsx"], dir)).toBeUndefined();
      git("init");
      writeFileSync(join(dir, "page.tsx"), "original content");
      git("add", "page.tsx");
      execFileSync("git", ["-c", "user.name=SEO test", "-c", "user.email=seo@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"], {
        cwd: dir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_DATE: "2025-01-02T03:04:05Z", GIT_COMMITTER_DATE: "2025-01-02T03:04:05Z" },
      });
      writeFileSync(join(dir, "page.tsx"), "uncommitted content");
      expect(new Date(gitLastModified(["page.tsx"], dir)!).toISOString()).toBe("2025-01-02T03:04:05.000Z");
      expect(gitLastModified(["missing.tsx"], dir)).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
