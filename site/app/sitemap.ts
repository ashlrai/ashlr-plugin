import type { MetadataRoute } from "next";
import { source } from "@/app/source";
import { getAllPosts } from "@/lib/blog";
import { useCases } from "@/lib/use-cases";
import { marketingPaths, sitemapEntries } from "@/lib/sitemap";

// Git history is available during the build, not in a deployed serverless bundle.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapEntries([
    ...marketingPaths.map((path) => ({
      path,
      files: [path === "/" ? "site/app/page.tsx" : `site/app${path}/page.tsx`,
        ...(path === "/" ? [
          "hero", "codex-native", "before-after", "how-it-works", "tools-grid",
          "pricing-preview", "social-proof", "terminal-mock", "copy-button",
        ].map((name) => `site/components/${name}.tsx`) : []),
        ...(path === "/blog" ? ["site/content/blog"] : []),
        ...(path === "/use-cases" ? ["site/lib/use-cases.ts"] : [])],
    })),
    ...source.getPages().map((page) => ({
      path: page.url,
      files: [`site/content/docs/${page.file.path}`, "site/app/docs", "site/app/layout.config.tsx"],
    })),
    ...getAllPosts().map((post) => ({
      path: `/blog/${post.slug}`,
      files: [`site/content/blog/${post.slug}.mdx`, "site/app/blog/[slug]/page.tsx"],
    })),
    ...useCases.map((page) => ({
      path: `/use-cases/${page.slug}`,
      files: ["site/lib/use-cases.ts", "site/app/use-cases/[slug]/page.tsx"],
    })),
  ]);
}
