import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const readSite = (path: string) => readFileSync(join(ROOT, "site", path), "utf8");

function openGraphBlock(source: string, file: string): string {
  const start = source.indexOf("openGraph:");
  if (start === -1) throw new Error(`${file}: no openGraph metadata`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(braceStart, i + 1);
  }
  throw new Error(`${file}: unbalanced openGraph block`);
}

function expectContains(haystack: string, needle: string, file: string) {
  if (!haystack.includes(needle)) throw new Error(`${file}: missing ${JSON.stringify(needle)}`);
}

// Mirrors site/tests/discoverability_test.py's per-page contract without a
// build: every public page must declare a self-referencing canonical and an
// OpenGraph block with title, description, and url equal to the canonical.
const STATIC_PAGES: Record<string, string> = {
  benchmarks: "app/benchmarks/page.tsx",
  blog: "app/blog/page.tsx",
  community: "app/community/page.tsx",
  compare: "app/compare/page.tsx",
  dpa: "app/dpa/page.tsx",
  pricing: "app/pricing/page.tsx",
  privacy: "app/privacy/page.tsx",
  roadmap: "app/roadmap/page.tsx",
  terms: "app/terms/page.tsx",
};

const DYNAMIC_PAGES = ["app/blog/[slug]/page.tsx", "app/docs/[[...slug]]/page.tsx"];

describe("public page metadata contract", () => {
  test("static public pages declare canonical and a complete OpenGraph block", () => {
    for (const [route, file] of Object.entries(STATIC_PAGES)) {
      const source = readSite(file);
      expectContains(source, `canonical: "/${route}"`, file);
      const og = openGraphBlock(source, file);
      expectContains(og, "title:", file);
      expectContains(og, "description:", file);
      expectContains(og, `url: "/${route}"`, file);
    }
  });

  test("homepage inherits canonical and OpenGraph defaults from the root layout", () => {
    const source = readSite("app/layout.tsx");
    expectContains(source, 'canonical: "/"', "app/layout.tsx");
    const og = openGraphBlock(source, "app/layout.tsx");
    expectContains(og, "title:", "app/layout.tsx");
    expectContains(og, "description:", "app/layout.tsx");
    expectContains(og, 'url: "https://plugin.ashlr.ai/"', "app/layout.tsx");
  });

  test("dynamic public pages generate canonical and OpenGraph metadata", () => {
    for (const file of DYNAMIC_PAGES) {
      const source = readSite(file);
      expectContains(source, "generateMetadata", file);
      expectContains(source, "canonical:", file);
      const og = openGraphBlock(source, file);
      expectContains(og, "title:", file);
      expectContains(og, "description:", file);
      expectContains(og, "url:", file);
    }
  });

  test("sitemap enumerates exactly the public page inventory from generated sources", () => {
    const source = readSite("app/sitemap.ts");
    const templated = [...source.matchAll(/\$\{BASE\}(\/[a-z-]+)(?=`)/g)].map((m) => m[1]);
    const literal = [...source.matchAll(/url: BASE\b/g)].map(() => "/");
    const routes = [...templated, ...literal].sort();
    const expected = ["/", ...Object.keys(STATIC_PAGES).map((r) => `/${r}`), "/docs"].sort();
    if (JSON.stringify(routes) !== JSON.stringify(expected)) {
      throw new Error(`sitemap static routes ${JSON.stringify(routes)} != expected ${JSON.stringify(expected)}`);
    }
    expectContains(source, 'docs.generated.json', "app/sitemap.ts");
    expectContains(source, "getAllPosts", "app/sitemap.ts");
    expectContains(source, "new Map(", "app/sitemap.ts");
  });
});
