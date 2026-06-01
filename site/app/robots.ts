import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        // Allow all crawlers including AI agents (GPTBot, ClaudeBot, etc.)
        userAgent: "*",
        allow: "/",
        // Keep admin/auth/billing/dashboard private
        disallow: ["/admin/", "/auth/", "/billing/", "/dashboard/", "/signin/"],
      },
    ],
    sitemap: "https://plugin.ashlr.ai/sitemap.xml",
    // Point AI agents to the structured LLM index
    // (Not a standard robots.txt field but supported by some crawlers as a comment)
  };
}
