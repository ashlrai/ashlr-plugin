import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const SITE_URL = "https://plugin.ashlr.ai";
export const marketingPaths = ["/", "/benchmarks", "/compare", "/pricing", "/roadmap", "/community", "/blog", "/use-cases", "/privacy", "/terms", "/dpa"];

export function canonicalUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[?#]/.test(path)) {
    throw new Error(`Expected a canonical site path: ${path}`);
  }
  return new URL(path === "/" ? path : path.replace(/\/+$/, ""), SITE_URL).href;
}

// Build-time only. Include shared presentation because it changes rendered pages.
// A source archive without Git has no honest lastmod: omit it rather than use now.
export function gitLastModified(paths: string[], root = resolve(process.cwd(), existsSync("content/docs") ? ".." : ".")): string | undefined {
  try {
    const value = execFileSync("git", ["log", "-1", "--format=%cI", "--", ...paths], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function sitemapEntries(pages: { path: string; files: string[] }[]) {
  const unique = new Map(pages.map((page) => [canonicalUrl(page.path), page]));
  return [...unique].map(([url, page]) => ({
    url,
    lastModified: gitLastModified([...page.files, "site/app/layout.tsx", "site/app/globals.css", "site/components/nav.tsx", "site/components/footer.tsx"]),
  }));
}
