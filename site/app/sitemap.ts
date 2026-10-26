import type { MetadataRoute } from "next";
import docs from "@/lib/docs.generated.json";
import { getAllPosts } from "@/lib/blog";

const BASE = "https://plugin.ashlr.ai";

export default function sitemap(): MetadataRoute.Sitemap {
  // Do not claim build time is content modification time. Only blog posts
  // have a source publication date; other URLs intentionally omit the field.
  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: BASE,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${BASE}/benchmarks`,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${BASE}/compare`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE}/pricing`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE}/roadmap`,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE}/blog`,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${BASE}/docs`,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${BASE}/privacy`,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${BASE}/terms`,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${BASE}/dpa`,
      changeFrequency: "yearly",
      priority: 0.2,
    },
  ];

  staticRoutes.push({
    url: `${BASE}/community`,
    changeFrequency: "weekly",
    priority: 0.8,
  });

  // Use the same generated documentation URLs as the AI endpoints.
  const docsRoutes: MetadataRoute.Sitemap = docs.map((page) => ({
    url: `${BASE}${page.url}`,
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));

  // Use a valid source date for blog posts where available.
  const blogRoutes: MetadataRoute.Sitemap = getAllPosts().map((post) => ({
    url: `${BASE}/blog/${post.slug}`,
    ...(post.date && Number.isFinite(Date.parse(post.date))
      ? { lastModified: new Date(post.date) }
      : {}),
    changeFrequency: "yearly" as const,
    priority: 0.6,
  }));

  return [...new Map([...staticRoutes, ...docsRoutes, ...blogRoutes]
    .map((route) => [route.url, route])).values()];
}
